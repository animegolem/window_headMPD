//! Audio engine: MPD's PCM in, EQ'd sound and spectrum frames out.
//!
//! MPD writes what it's playing to a dedicated FIFO output ("Headspace").
//! A reader thread moves that PCM into a ring. The cpal output stream pulls
//! from the ring, runs the EQ, resamples to the device rate, and taps what
//! it actually plays for analysis, so the visuals line up with your ears.
//!
//! MPD's FIFO output is paced by MPD's clock and the sound card by its own,
//! so the resampler nudges its ratio a hair (at most 0.2%, well under a
//! perceptible pitch change) to hold the ring at its target fill.
//!
//! If no output device can be opened, the engine falls back to "monitor"
//! mode: analysis only, with MPD's own output left in charge of sound.

use crate::eq::Eq;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

pub const FIFO_PATH: &str = "/tmp/headspace.fifo";
/// Must match `format` on the Headspace output in mpd.conf.
pub const IN_RATE: f32 = 44100.0;

/// ~100 ms: comfortably above MPD's write bursts, small enough that pause
/// and seek feel immediate.
const TARGET_FRAMES: usize = 4410;
const MAX_FRAMES: usize = TARGET_FRAMES * 4;

const FFT_SIZE: usize = 2048;
pub const N_BANDS: usize = 64;
const WAVE_POINTS: usize = 256;
const TAP_LEN: usize = 4096;

#[derive(Clone, Serialize)]
pub struct Frame {
    pub bands: Vec<f32>,
    pub wave: Vec<f32>,
    pub level: f32,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// We are MPD's speaker: EQ and balance are live.
    Output,
    /// MPD plays through its own output; we only watch.
    Monitor,
}

struct Tap {
    samples: VecDeque<f32>,
    last: Instant,
}

pub struct Engine {
    ring: Mutex<VecDeque<[f32; 2]>>,
    tap: Mutex<Tap>,
    pub eq: Mutex<Eq>,
    /// True while the output stream owns the ring. In monitor mode the
    /// reader feeds the analysis tap directly.
    playing_out: AtomicBool,
    subscriber: Mutex<Option<Channel<Frame>>>,
    mode: Mutex<Mode>,
}

impl Engine {
    pub fn mode(&self) -> Mode {
        *self.mode.lock().unwrap()
    }

    pub fn subscribe(&self, ch: Channel<Frame>) {
        *self.subscriber.lock().unwrap() = Some(ch);
    }
}

/// Start the reader, output and analysis threads. Returns the engine and,
/// in output mode, the stream (which must be kept alive).
pub fn start() -> (Arc<Engine>, Option<cpal::Stream>) {
    ensure_fifo();
    let engine = Arc::new(Engine {
        ring: Mutex::new(VecDeque::with_capacity(MAX_FRAMES * 2)),
        tap: Mutex::new(Tap {
            samples: VecDeque::from(vec![0.0; TAP_LEN]),
            last: Instant::now(),
        }),
        eq: Mutex::new(Eq::new(IN_RATE)),
        playing_out: AtomicBool::new(false),
        subscriber: Mutex::new(None),
        mode: Mutex::new(Mode::Monitor),
    });

    let stream = match open_output(engine.clone()) {
        Ok(s) => {
            engine.playing_out.store(true, Ordering::Release);
            *engine.mode.lock().unwrap() = Mode::Output;
            Some(s)
        }
        Err(e) => {
            eprintln!("[audio] no output device, monitor mode only: {e}");
            None
        }
    };

    let r = engine.clone();
    std::thread::Builder::new()
        .name("fifo-reader".into())
        .spawn(move || reader(r))
        .expect("spawn reader");
    let a = engine.clone();
    std::thread::Builder::new()
        .name("analysis".into())
        .spawn(move || analysis(a))
        .expect("spawn analysis");

    (engine, stream)
}

/// Pre-create the FIFO. When MPD creates it, MPD also deletes it on every
/// close (pause, stop), which forces readers to chase a moving inode.
fn ensure_fifo() {
    if Path::new(FIFO_PATH).exists() {
        return;
    }
    let c = std::ffi::CString::new(FIFO_PATH).unwrap();
    // SAFETY: plain libc call with a valid NUL-terminated path.
    unsafe {
        libc::mkfifo(c.as_ptr(), 0o644);
    }
}

fn open_fifo() -> Option<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(FIFO_PATH)
        .ok()
}

fn reader(engine: Arc<Engine>) {
    let mut file: Option<File> = None;
    let mut raw = vec![0u8; 8192];
    // A pipe read can split a frame anywhere; carry the remainder.
    let mut carry: Vec<u8> = Vec::with_capacity(4);
    let mut frames: Vec<[f32; 2]> = Vec::with_capacity(4096);
    loop {
        let Some(f) = file.as_mut() else {
            ensure_fifo();
            file = open_fifo();
            if file.is_none() {
                std::thread::sleep(Duration::from_millis(250));
            }
            continue;
        };
        match f.read(&mut raw) {
            Ok(0) => {
                // No writer: MPD closed the output (pause, stop, disable).
                // Reopen so a recreated FIFO is picked up too.
                file = None;
                carry.clear();
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(n) => {
                carry.extend_from_slice(&raw[..n]);
                let whole = carry.len() / 4 * 4;
                frames.clear();
                for fr in carry[..whole].chunks_exact(4) {
                    let l = i16::from_le_bytes([fr[0], fr[1]]) as f32 / 32768.0;
                    let r = i16::from_le_bytes([fr[2], fr[3]]) as f32 / 32768.0;
                    frames.push([l, r]);
                }
                carry.drain(..whole);
                if engine.playing_out.load(Ordering::Acquire) {
                    let mut ring = engine.ring.lock().unwrap();
                    ring.extend(frames.iter().copied());
                    // A long stall then a burst: drop the backlog rather than
                    // play it late.
                    if ring.len() > MAX_FRAMES {
                        let excess = ring.len() - TARGET_FRAMES;
                        ring.drain(..excess);
                    }
                } else {
                    push_tap(&engine, frames.iter().map(|[l, r]| (l + r) * 0.5));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(_) => {
                file = None;
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

fn push_tap(engine: &Engine, samples: impl Iterator<Item = f32>) {
    let mut tap = engine.tap.lock().unwrap();
    let mut any = false;
    for s in samples {
        tap.samples.push_back(s);
        any = true;
    }
    let over = tap.samples.len().saturating_sub(TAP_LEN);
    tap.samples.drain(..over);
    if any {
        tap.last = Instant::now();
    }
}

fn open_output(engine: Arc<Engine>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no default output device")?;
    let config = device.default_output_config().map_err(|e| e.to_string())?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("unsupported sample format {:?}", config.sample_format()));
    }
    let config: cpal::StreamConfig = config.into();
    let channels = config.channels as usize;
    let out_rate = config.sample_rate as f32;
    let base_step = IN_RATE / out_rate;

    // Cubic interpolation history: [x(-1), x0, x1, x2].
    let mut hist = [[0.0f32; 2]; 4];
    let mut frac = 0.0f32;
    let mut primed = false;
    let mut tap_buf: Vec<f32> = Vec::with_capacity(4096);

    let stream = device
        .build_output_stream(
            config,
            move |out: &mut [f32], _| {
                tap_buf.clear();
                let mut ring = engine.ring.lock().unwrap();
                let fill = ring.len();
                if !primed && fill >= TARGET_FRAMES {
                    primed = true;
                }
                if !primed {
                    out.fill(0.0);
                    return;
                }
                let err = (fill as f32 - TARGET_FRAMES as f32) / TARGET_FRAMES as f32;
                let step = base_step * (1.0 + 0.002 * err.clamp(-1.0, 1.0));
                let mut eq = engine.eq.lock().unwrap();
                for frame in out.chunks_mut(channels) {
                    frac += step;
                    while frac >= 1.0 {
                        let Some(x) = ring.pop_front() else {
                            // Ran dry (pause/stop): go quiet and re-prime.
                            primed = false;
                            break;
                        };
                        let y = eq.process(x);
                        tap_buf.push((y[0] + y[1]) * 0.5);
                        hist = [hist[1], hist[2], hist[3], y];
                        frac -= 1.0;
                    }
                    if !primed {
                        frac = 0.0;
                        frame.fill(0.0);
                        continue;
                    }
                    let s = cubic(&hist, frac);
                    frame[0] = s[0];
                    if channels > 1 {
                        frame[1] = s[1];
                        frame[2..].fill(0.0);
                    }
                }
                drop(eq);
                drop(ring);
                push_tap(&engine, tap_buf.iter().copied());
            },
            |e| eprintln!("[audio] stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

/// Catmull-Rom between hist[1] and hist[2].
#[inline]
fn cubic(h: &[[f32; 2]; 4], t: f32) -> [f32; 2] {
    let mut o = [0.0; 2];
    for c in 0..2 {
        let (p0, p1, p2, p3) = (h[0][c], h[1][c], h[2][c], h[3][c]);
        o[c] = p1
            + 0.5
                * t
                * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)));
    }
    o
}

fn analysis(engine: Arc<Engine>) {
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
    let window: Vec<f32> = (0..FFT_SIZE)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
        .collect();
    // Log-spaced band edges, 30 Hz .. 16 kHz, as FFT bin indices.
    let bin_hz = IN_RATE / FFT_SIZE as f32;
    let edges: Vec<usize> = (0..=N_BANDS)
        .map(|i| {
            let f = 30.0 * (16000.0f32 / 30.0).powf(i as f32 / N_BANDS as f32);
            ((f / bin_hz).round() as usize).clamp(1, FFT_SIZE / 2 - 1)
        })
        .collect();
    let mut buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
    let mut smooth = vec![0.0f32; N_BANDS];
    let mut snapshot = vec![0.0f32; FFT_SIZE];
    let frame_time = Duration::from_micros(16_667);

    loop {
        let t0 = Instant::now();
        let silent;
        {
            let tap = engine.tap.lock().unwrap();
            silent = tap.last.elapsed() > Duration::from_millis(150);
            let start = tap.samples.len() - FFT_SIZE;
            for (d, s) in snapshot.iter_mut().zip(tap.samples.range(start..)) {
                *d = *s;
            }
        }
        if silent {
            snapshot.fill(0.0);
        }
        for (i, c) in buf.iter_mut().enumerate() {
            *c = Complex::new(snapshot[i] * window[i], 0.0);
        }
        fft.process(&mut buf);

        let norm = 2.0 / (FFT_SIZE as f32 * 0.5);
        for b in 0..N_BANDS {
            let (lo, hi) = (edges[b], edges[b + 1].max(edges[b] + 1));
            let peak = buf[lo..hi].iter().map(|c| c.norm()).fold(0.0f32, f32::max) * norm;
            let db = 20.0 * peak.max(1e-9).log10();
            // Tilt +3 dB/oct so treble reads as lively as bass does.
            let tilt = 3.0 * (b as f32 / N_BANDS as f32) * (16000.0f32 / 30.0).log2();
            // -60 dB .. 0 dB (tilted) -> 0 .. 1.
            let v = ((db + tilt + 60.0) / 60.0).clamp(0.0, 1.0);
            smooth[b] = if v > smooth[b] { v } else { smooth[b] * 0.88 + v * 0.12 };
        }
        let tail = &snapshot[FFT_SIZE - WAVE_POINTS * 2..];
        let wave: Vec<f32> = tail.chunks(2).map(|c| round3(c[0])).collect();
        let level = (snapshot.iter().map(|s| s * s).sum::<f32>() / FFT_SIZE as f32).sqrt();

        let ch = engine.subscriber.lock().unwrap().clone();
        if let Some(ch) = ch {
            let frame = Frame {
                bands: smooth.iter().map(|v| round3(*v)).collect(),
                wave,
                level: round3(level),
            };
            if ch.send(frame).is_err() {
                *engine.subscriber.lock().unwrap() = None;
            }
        }
        if let Some(rest) = frame_time.checked_sub(t0.elapsed()) {
            std::thread::sleep(rest);
        }
    }
}

fn round3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}
