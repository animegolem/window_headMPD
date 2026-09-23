//! Let clicks fall through the skin's transparent pixels.
//!
//! A transparent macOS window still swallows every click inside its frame.
//! The frontend sends a 1-bit mask of where the skin is opaque (redrawn when
//! drawers move); this thread watches the cursor and toggles
//! `ignore_cursor_events` as it crosses between skin and empty space. While a
//! drag is in progress the frontend holds a capture so a slider thumb pulled
//! off the skin keeps tracking.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub struct Mask {
    pub width: usize,
    pub height: usize,
    /// Row-major, 1 bit per logical pixel, LSB first.
    pub bits: Vec<u8>,
    /// Frontend zoom: mask pixels are skin pixels, not window points.
    pub zoom: f64,
}

impl Mask {
    fn hit(&self, x: f64, y: f64) -> bool {
        let (x, y) = (x / self.zoom, y / self.zoom);
        if x < 0.0 || y < 0.0 {
            return false;
        }
        let (x, y) = (x as usize, y as usize);
        if x >= self.width || y >= self.height {
            return false;
        }
        let i = y * self.width + x;
        self.bits.get(i / 8).is_some_and(|b| b >> (i % 8) & 1 == 1)
    }
}

#[derive(Default)]
pub struct HitState {
    pub mask: Mutex<Option<Mask>>,
    pub capture: AtomicBool,
}

pub fn start(app: AppHandle, state: Arc<HitState>) {
    std::thread::Builder::new()
        .name("clickthrough".into())
        .spawn(move || {
            let mut ignoring: Option<bool> = None;
            loop {
                std::thread::sleep(Duration::from_millis(16));
                let Some(win) = app.get_webview_window("main") else { continue };
                let want_ignore = if state.capture.load(Ordering::Relaxed) {
                    false
                } else {
                    let (Ok(cursor), Ok(pos), Ok(scale)) =
                        (app.cursor_position(), win.outer_position(), win.scale_factor())
                    else {
                        continue;
                    };
                    let lx = (cursor.x - pos.x as f64) / scale;
                    let ly = (cursor.y - pos.y as f64) / scale;
                    match &*state.mask.lock().unwrap() {
                        Some(m) => !m.hit(lx, ly),
                        // No mask yet: stay clickable so the page can load.
                        None => false,
                    }
                };
                if ignoring != Some(want_ignore) {
                    if win.set_ignore_cursor_events(want_ignore).is_ok() {
                        ignoring = Some(want_ignore);
                    }
                }
            }
        })
        .expect("spawn clickthrough");
}
