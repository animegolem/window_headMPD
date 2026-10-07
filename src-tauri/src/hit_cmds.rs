//! Click-through glue (ENGINE.md D7.1): the commands that feed `headcore::hit::HitTable` and the
//! thread that turns it into `set_ignore_cursor_events`. Replaces `clickthrough.rs`.
//!
//! Every command acts on the calling window's label; no command takes a label, so a page cannot
//! set another window's shape or capture.

use headcore::hit::{decode_bits_body, HitTable, Region, Shape};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State, WebviewWindow};

/// The poll period, and the faster one while two registered windows overlap (the cursor can cross
/// from one skin into another between ticks).
const POLL: Duration = Duration::from_millis(16);
const POLL_OVERLAP: Duration = Duration::from_millis(8);

/// Bounds on `hit_set_regions`, far above Webamp's needs (a handful of windows, `region.txt`
/// polygons of tens of points), so a page cannot park an unbounded shape in the table.
const MAX_REGIONS: usize = 1024;
const MAX_POLY_COORDS: usize = 8192;

#[derive(Default)]
pub struct Hit(Mutex<HitTable>);

impl Hit {
    fn table(&self) -> MutexGuard<'_, HitTable> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Forgets a destroyed or reloading window: its shape and any capture it held. Until the page
    /// sends a new shape the window is clickable, as at first boot.
    pub fn forget(&self, label: &str) {
        self.table().remove(label);
    }
}

/// The mask as a raw body: `u32 w, u32 h, f64 zoom` little-endian, then the bits (E D7.1, G1).
#[tauri::command]
pub fn hit_set_bits(
    window: WebviewWindow,
    hit: State<'_, Hit>,
    request: Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("hit_set_bits takes a raw byte body, not JSON".into());
    };
    let (shape, zoom) = decode_bits_body(body)?;
    hit.table().set_shape(window.label(), shape, zoom);
    Ok(())
}

#[tauri::command]
pub fn hit_set_regions(
    window: WebviewWindow,
    hit: State<'_, Hit>,
    regions: Vec<Region>,
    zoom: f64,
) -> Result<(), String> {
    check_regions(&regions, zoom)?;
    hit.table()
        .set_shape(window.label(), Shape::Regions(regions), zoom);
    Ok(())
}

#[tauri::command]
pub fn hit_capture(window: WebviewWindow, hit: State<'_, Hit>, on: bool) {
    hit.table().set_capture(window.label(), on);
}

/// Legacy `set_hit_mask` (`main.js`), kept until cutover: the same table entry as `hit_set_bits`,
/// fed from a JSON number array.
#[tauri::command]
pub fn set_hit_mask(
    window: WebviewWindow,
    hit: State<'_, Hit>,
    width: usize,
    height: usize,
    bits: Vec<u8>,
    zoom: f64,
) -> Result<(), String> {
    check_zoom(zoom)?;
    let shape = Shape::from_legacy(width, height, bits)?;
    hit.table().set_shape(window.label(), shape, zoom);
    Ok(())
}

/// Legacy `set_capture` (`widgets.js`), kept until cutover.
#[tauri::command]
pub fn set_capture(window: WebviewWindow, hit: State<'_, Hit>, on: bool) {
    hit.table().set_capture(window.label(), on);
}

fn check_zoom(zoom: f64) -> Result<(), String> {
    if zoom.is_finite() && zoom > 0.0 {
        Ok(())
    } else {
        Err(format!("hit zoom must be finite and positive, got {zoom}"))
    }
}

/// An empty list would make the window unreachable, the same reason `decode_bits_body` refuses
/// an empty mask.
fn check_regions(regions: &[Region], zoom: f64) -> Result<(), String> {
    check_zoom(zoom)?;
    if regions.is_empty() {
        return Err("hit regions are empty".into());
    }
    if regions.len() > MAX_REGIONS {
        return Err(format!(
            "{} hit regions, the cap is {MAX_REGIONS}",
            regions.len()
        ));
    }
    let coords: usize = regions
        .iter()
        .map(|r| r.poly.as_ref().map_or(0, Vec::len))
        .sum();
    if coords > MAX_POLY_COORDS {
        return Err(format!(
            "{coords} polygon coordinates, the cap is {MAX_POLY_COORDS}"
        ));
    }
    Ok(())
}

/// A window's outer frame in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Frame {
    /// Open intervals, so windows that only share an edge do not count as overlapping.
    fn intersects(&self, o: &Frame) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
}

fn any_overlap(frames: &[Frame]) -> bool {
    frames
        .iter()
        .enumerate()
        .any(|(i, a)| frames[i + 1..].iter().any(|b| a.intersects(b)))
}

fn poll_interval(frames: &[Frame]) -> Duration {
    if any_overlap(frames) {
        POLL_OVERLAP
    } else {
        POLL
    }
}

fn frame_of(win: &WebviewWindow) -> Option<Frame> {
    let (pos, size) = (win.outer_position().ok()?, win.outer_size().ok()?);
    Some(Frame {
        x: f64::from(pos.x),
        y: f64::from(pos.y),
        w: f64::from(size.width),
        h: f64::from(size.height),
    })
}

/// The cursor (physical screen pixels) in the window's local logical pixels, the space
/// `HitTable::want_ignore` takes.
fn local_cursor(cursor: (f64, f64), win: &WebviewWindow) -> Option<(f64, f64)> {
    let pos = win.outer_position().ok()?;
    let scale = win.scale_factor().ok()?;
    Some((
        (cursor.0 - f64::from(pos.x)) / scale,
        (cursor.1 - f64::from(pos.y)) / scale,
    ))
}

/// Watches the cursor over every registered window and toggles click-through as it crosses
/// between skin and empty space. Window geometry is read without holding the table lock: on macOS
/// those calls wait on the main thread, which may itself be waiting on the lock in a hit command.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("clickthrough".into())
        .spawn(move || {
            // What was last applied per label. A label that left the table stays here until it has
            // been made clickable again, so a forgotten window is never stranded click-through.
            let mut applied: HashMap<String, bool> = HashMap::new();
            let mut interval = POLL;
            loop {
                std::thread::sleep(interval);
                let hit = app.state::<Hit>();
                let registered: Vec<String> = hit.table().labels().map(str::to_owned).collect();
                let mut labels = registered.clone();
                labels.extend(applied.keys().filter(|l| !registered.contains(l)).cloned());

                let cursor = app.cursor_position().ok().map(|c| (c.x, c.y));
                let mut frames = Vec::new();
                for label in &labels {
                    let Some(win) = app.get_webview_window(label) else {
                        applied.remove(label);
                        continue;
                    };
                    let is_registered = registered.contains(label);
                    if registered.len() > 1 && is_registered {
                        frames.extend(frame_of(&win));
                    }
                    let want = if is_registered {
                        let Some((x, y)) = cursor.and_then(|c| local_cursor(c, &win)) else {
                            continue;
                        };
                        hit.table().want_ignore(label, x, y)
                    } else {
                        false
                    };
                    if applied.get(label) != Some(&want)
                        && win.set_ignore_cursor_events(want).is_ok()
                    {
                        applied.insert(label.clone(), want);
                    }
                    if !is_registered && applied.get(label) == Some(&false) {
                        applied.remove(label);
                    }
                }
                interval = poll_interval(&frames);
            }
        })
        .expect("spawn clickthrough");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(x: f64, y: f64, w: f64, h: f64) -> Frame {
        Frame { x, y, w, h }
    }

    #[test]
    fn one_or_no_window_polls_at_16_ms() {
        assert_eq!(poll_interval(&[]), POLL);
        assert_eq!(poll_interval(&[f(0.0, 0.0, 760.0, 394.0)]), POLL);
        assert_eq!(POLL, Duration::from_millis(16));
    }

    #[test]
    fn overlapping_windows_poll_at_8_ms() {
        let frames = [f(0.0, 0.0, 760.0, 394.0), f(700.0, 300.0, 200.0, 200.0)];
        assert_eq!(poll_interval(&frames), POLL_OVERLAP);
        assert_eq!(POLL_OVERLAP, Duration::from_millis(8));
    }

    #[test]
    fn apart_or_edge_sharing_windows_do_not_overlap() {
        let a = f(0.0, 0.0, 100.0, 100.0);
        assert!(!any_overlap(&[a, f(200.0, 0.0, 50.0, 50.0)]));
        // Sharing the right edge, then the bottom edge, exactly.
        assert!(!any_overlap(&[a, f(100.0, 0.0, 50.0, 50.0)]));
        assert!(!any_overlap(&[a, f(0.0, 100.0, 50.0, 50.0)]));
        // One pixel in.
        assert!(any_overlap(&[a, f(99.0, 99.0, 50.0, 50.0)]));
    }

    #[test]
    fn any_pair_counts_not_just_neighbours() {
        let frames = [
            f(0.0, 0.0, 10.0, 10.0),
            f(500.0, 500.0, 10.0, 10.0),
            f(5.0, 5.0, 10.0, 10.0),
        ];
        assert!(any_overlap(&frames));
        // Containment overlaps too.
        assert!(any_overlap(&[
            f(0.0, 0.0, 100.0, 100.0),
            f(10.0, 10.0, 5.0, 5.0)
        ]));
    }

    #[test]
    fn zoom_must_be_finite_and_positive() {
        assert!(check_zoom(1.0).is_ok());
        assert!(check_zoom(1.5).is_ok());
        for z in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(check_zoom(z).is_err(), "{z}");
        }
    }

    fn rect(poly: Option<Vec<f64>>) -> Region {
        Region {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
            poly,
        }
    }

    #[test]
    fn regions_are_refused_when_empty_oversized_or_badly_zoomed() {
        assert!(check_regions(&[rect(None)], 1.0).is_ok());
        assert!(check_regions(&[], 1.0).is_err());
        assert!(check_regions(&[rect(None)], 0.0).is_err());
        assert!(check_regions(&vec![rect(None); MAX_REGIONS], 1.0).is_ok());
        assert!(check_regions(&vec![rect(None); MAX_REGIONS + 1], 1.0).is_err());
        assert!(check_regions(&[rect(Some(vec![0.0; MAX_POLY_COORDS]))], 1.0).is_ok());
        let split = [
            rect(Some(vec![0.0; MAX_POLY_COORDS / 2])),
            rect(Some(vec![0.0; MAX_POLY_COORDS / 2 + 1])),
        ];
        assert!(
            check_regions(&split, 1.0).is_err(),
            "the cap is over all regions"
        );
    }

    #[test]
    fn regions_deserialize_from_the_js_shape() {
        // What `invoke('hit_set_regions', { regions, zoom })` sends; `poly` is optional.
        let json = r#"[{"x":1,"y":2,"w":3,"h":4},{"x":0,"y":0,"w":9,"h":9,"poly":[0,0,9,0,0,9]}]"#;
        let regions: Vec<Region> = serde_json::from_str(json).unwrap();
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].poly, None);
        assert_eq!(
            regions[1].poly.as_deref(),
            Some(&[0.0, 0.0, 9.0, 0.0, 0.0, 9.0][..])
        );
    }
}
