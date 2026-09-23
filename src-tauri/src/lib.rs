mod audio;
mod clickthrough;
mod eq;
mod mpd;
mod outputs;

use audio::{Engine, Frame, Mode};
use clickthrough::{HitState, Mask};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct App {
    cmd: Mutex<Option<mpd::Conn>>,
    engine: Arc<Engine>,
    hit: Arc<HitState>,
    takeover: Mutex<Option<outputs::Takeover>>,
    /// Why the Headspace output isn't in use, if it isn't.
    route_error: Mutex<Option<String>>,
}

// ---- MPD -------------------------------------------------------------------

/// Run one MPD command on the shared command connection, reconnecting once
/// if the server dropped us (MPD closes idle clients after a minute).
#[tauri::command]
fn mpd(app: State<'_, App>, args: Vec<String>) -> Result<mpd::Pairs, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut slot = app.cmd.lock().unwrap();
    for attempt in 0..2 {
        if slot.is_none() {
            let c = mpd::Conn::connect().map_err(|e| format!("MPD unreachable: {e}"))?;
            c.set_read_timeout(Some(Duration::from_secs(5))).ok();
            *slot = Some(c);
        }
        match slot.as_mut().unwrap().command(&args) {
            Ok(r) => return r,
            Err(e) => {
                *slot = None;
                if attempt == 1 {
                    return Err(e.to_string());
                }
            }
        }
    }
    unreachable!()
}

/// Watch MPD's `idle` stream and forward change notices to the page. Also
/// routes MPD into the app the first time we reach it.
fn idle_loop(handle: AppHandle) {
    let mut routed = false;
    loop {
        let Ok(mut conn) = mpd::Conn::connect() else {
            let _ = handle.emit("mpd-connection", false);
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        if !routed {
            route(&handle, &mut conn);
            routed = true;
        }
        let _ = handle.emit("mpd-connection", true);
        loop {
            match conn.command(&["idle"]) {
                Ok(Ok(pairs)) => {
                    let changed: Vec<String> = pairs
                        .into_iter()
                        .filter(|(k, _)| k == "changed")
                        .map(|(_, v)| v)
                        .collect();
                    let _ = handle.emit("mpd-idle", changed);
                }
                Ok(Err(_)) => continue,
                Err(_) => break,
            }
        }
        let _ = handle.emit("mpd-connection", false);
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn route(handle: &AppHandle, conn: &mut mpd::Conn) {
    let app = handle.state::<App>();
    outputs::recover(conn);
    if !outputs::has_ours(conn) {
        *app.route_error.lock().unwrap() = Some(format!(
            "Add the \"{}\" FIFO output to mpd.conf (see README)",
            outputs::OUR_OUTPUT
        ));
        return;
    }
    let silence = app.engine.mode() == Mode::Output;
    match outputs::take(conn, silence) {
        Ok(t) => *app.takeover.lock().unwrap() = Some(t),
        Err(e) => *app.route_error.lock().unwrap() = Some(e),
    }
}

fn give_back(app: &App) {
    if let Some(t) = app.takeover.lock().unwrap().take() {
        if let Ok(mut conn) = mpd::Conn::connect() {
            outputs::give_back(&mut conn, &t);
        }
    }
}

// ---- audio -----------------------------------------------------------------

#[tauri::command]
fn audio_subscribe(app: State<'_, App>, on_frame: Channel<Frame>) {
    app.engine.subscribe(on_frame);
}

#[tauri::command]
fn set_eq(app: State<'_, App>, gains: [f32; 10]) {
    app.engine.eq.lock().unwrap().set_gains(gains);
}

#[tauri::command]
fn set_balance(app: State<'_, App>, balance: f32) {
    app.engine.eq.lock().unwrap().set_balance(balance);
}

#[derive(Serialize)]
struct EngineInfo {
    mode: Mode,
    routed: bool,
    error: Option<String>,
}

#[tauri::command]
fn engine_info(app: State<'_, App>) -> EngineInfo {
    EngineInfo {
        mode: app.engine.mode(),
        routed: app.takeover.lock().unwrap().is_some(),
        error: app.route_error.lock().unwrap().clone(),
    }
}

// ---- album-art palette -----------------------------------------------------

#[derive(Serialize)]
struct Swatch {
    hex: String,
    share: f64,
    oklch: [f32; 3],
}

/// OKLab k-means over the song's cover art (the same engine and settings
/// RMPC-Auto-Theme uses), dominance-ordered.
#[tauri::command]
async fn palette(file: String) -> Result<Vec<Swatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let art = mpd::fetch_art(&file)?;
        let req = color_core::AnalyzeRequest {
            path: String::new(),
            k: 8,
            stride: 4,
            quality: Some(2),
            ignore_top_n: 0,
            merge_threshold: 0.08,
            min_lum: 0,
            tol: 1e-3,
            max_iter: 40,
            seed: 1,
            max_samples: color_core::analyze::default_max_samples(),
            snap_to_real: false,
        };
        let res = color_core::analyze(&req, color_core::ImageSource::Bytes(&art))
            .map_err(|e| e.to_string())?;
        Ok(res
            .clusters
            .iter()
            .map(|c| Swatch {
                hex: format!("#{:02x}{:02x}{:02x}", c.rgb.r, c.rgb.g, c.rgb.b),
                share: c.share,
                oklch: c.oklch,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- click-through ---------------------------------------------------------

#[tauri::command]
fn set_hit_mask(app: State<'_, App>, width: usize, height: usize, bits: Vec<u8>, zoom: f64) {
    *app.hit.mask.lock().unwrap() = Some(Mask { width, height, bits, zoom });
}

#[tauri::command]
fn set_capture(app: State<'_, App>, on: bool) {
    app.hit.capture.store(on, Ordering::Relaxed);
}

/// Page errors land in the terminal running `tauri dev`.
#[tauri::command]
fn js_log(msg: String) {
    eprintln!("[page] {msg}");
}

// ---- boot ------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (engine, stream) = audio::start();
    // The stream plays for the life of the process; cpal streams aren't Send,
    // so rather than park it in managed state we let it live forever.
    std::mem::forget(stream);

    let hit = Arc::new(HitState::default());
    let app = tauri::Builder::default()
        .manage(App {
            cmd: Mutex::new(None),
            engine,
            hit: hit.clone(),
            takeover: Mutex::new(None),
            route_error: Mutex::new(None),
        })
        .setup(move |app| {
            let h = app.handle().clone();
            std::thread::Builder::new()
                .name("mpd-idle".into())
                .spawn(move || idle_loop(h))?;
            clickthrough::start(app.handle().clone(), hit.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mpd,
            audio_subscribe,
            set_eq,
            set_balance,
            engine_info,
            palette,
            set_hit_mask,
            set_capture,
            js_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building window_headMPD");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            give_back(&handle.state::<App>());
        }
    });
}
