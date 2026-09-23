//! The ten-band graphic EQ behind the skin's sliders.
//!
//! Standard RBJ-cookbook peaking biquads at WMP's own band centres, one per
//! slider, run in series per channel. Gains are in dB over WMP's -14..+14
//! range. Balance is a plain opposite-channel attenuation, like WMP's.

pub const BANDS: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// One octave of bandwidth: adjacent bands overlap smoothly without the
/// comb-ish ripple of a narrower Q.
const Q: f32 = 1.41;

#[derive(Clone, Copy, Default)]
struct Coeffs {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl Coeffs {
    fn peaking(fs: f32, f0: f32, gain_db: f32) -> Self {
        // Near-Nyquist bands (16k at 44.1k is fine, but guard anyway).
        let f0 = f0.min(fs * 0.45);
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
        let alpha = w0.sin() / (2.0 * Q);
        let cos = w0.cos();
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * cos) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * cos) / a0,
            a2: (1.0 - alpha / a) / a0,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct State {
    z1: f32,
    z2: f32,
}

pub struct Eq {
    fs: f32,
    gains: [f32; 10],
    coeffs: [Coeffs; 10],
    state: [[State; 10]; 2],
    flat: bool,
    pre: f32,
    bal: [f32; 2],
}

impl Eq {
    pub fn new(fs: f32) -> Self {
        let mut eq = Self {
            fs,
            gains: [0.0; 10],
            coeffs: [Coeffs::default(); 10],
            state: [[State::default(); 10]; 2],
            flat: true,
            pre: 1.0,
            bal: [1.0, 1.0],
        };
        eq.set_gains([0.0; 10]);
        eq
    }

    pub fn set_gains(&mut self, gains: [f32; 10]) {
        self.gains = gains.map(|g| g.clamp(-14.0, 14.0));
        for (i, c) in self.coeffs.iter_mut().enumerate() {
            *c = Coeffs::peaking(self.fs, BANDS[i], self.gains[i]);
        }
        self.flat = self.gains.iter().all(|g| g.abs() < 0.05);
        // Boosting into a hot master clips; trade some of the peak boost for
        // headroom and let the soft clipper catch the rest.
        let peak = self.gains.iter().cloned().fold(0.0f32, f32::max);
        self.pre = 10f32.powf(-peak * 0.6 / 20.0);
    }

    /// -100 (hard left) ..= 100 (hard right).
    pub fn set_balance(&mut self, b: f32) {
        let b = b.clamp(-100.0, 100.0) / 100.0;
        self.bal = [(1.0 - b).min(1.0), (1.0 + b).min(1.0)];
    }

    #[inline]
    pub fn process(&mut self, frame: [f32; 2]) -> [f32; 2] {
        let mut out = frame;
        for (ch, x) in out.iter_mut().enumerate() {
            let mut v = *x;
            if !self.flat {
                v *= self.pre;
                for (c, s) in self.coeffs.iter().zip(self.state[ch].iter_mut()) {
                    // Transposed direct form II.
                    let y = c.b0 * v + s.z1;
                    s.z1 = c.b1 * v - c.a1 * y + s.z2;
                    s.z2 = c.b2 * v - c.a2 * y;
                    v = y;
                }
                v = soft_clip(v);
            }
            *x = v * self.bal[ch];
        }
        out
    }
}

/// Transparent below ~-3 dBFS, rounds off above instead of wrapping.
#[inline]
fn soft_clip(x: f32) -> f32 {
    const K: f32 = 0.7;
    if x.abs() <= K {
        x
    } else {
        let s = x.signum();
        let over = (x.abs() - K) / (1.0 - K);
        s * (K + (1.0 - K) * over.tanh())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_is_identity() {
        let mut eq = Eq::new(44100.0);
        assert_eq!(eq.process([0.5, -0.25]), [0.5, -0.25]);
    }

    #[test]
    fn boost_raises_band_energy() {
        let fs = 44100.0;
        let tone = |eq: &mut Eq| {
            let mut peak = 0.0f32;
            for n in 0..44100 {
                let x = (2.0 * std::f32::consts::PI * 1000.0 * n as f32 / fs).sin() * 0.1;
                let y = eq.process([x, x])[0];
                if n > 4000 {
                    peak = peak.max(y.abs());
                }
            }
            peak
        };
        let mut flat = Eq::new(fs);
        let mut boosted = Eq::new(fs);
        let mut g = [0.0; 10];
        g[5] = 12.0;
        boosted.set_gains(g);
        // +12 dB at the band, minus the 7.2 dB headroom trim: ~ +4.8 dB.
        let ratio = tone(&mut boosted) / tone(&mut flat);
        assert!((ratio - 10f32.powf(4.8 / 20.0)).abs() < 0.1, "ratio {ratio}");
    }

    #[test]
    fn balance_attenuates_opposite_side() {
        let mut eq = Eq::new(44100.0);
        eq.set_balance(100.0);
        assert_eq!(eq.process([1.0, 1.0]), [0.0, 1.0]);
    }
}
