//! Per-window click-through tables (ENGINE.md D7.1).
//!
//! A transparent macOS window swallows every click inside its frame, so the app watches the cursor
//! and toggles `ignore_cursor_events` as it crosses between skin and empty space. This module is
//! the pure decision: given a window label and a window-local point, should clicks fall through?
//! The poll thread and the Tauri commands that feed it live in `src-tauri/src/hit_cmds.rs`.
//!
//! Every window owns its own shape and zoom, and `capture` names one window instead of a global
//! flag: a slider drag in window A forces only A clickable, so B still lets clicks through to
//! whatever lies beneath it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Bytes before the bit data in a [`decode_bits_body`] body: `u32` width, `u32` height, `f64` zoom.
const BITS_HEADER_LEN: usize = 16;

/// Where a window is clickable, in skin pixels.
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// One bit per skin pixel, row-major, LSB first: pixel `i = y * w + x` is bit `i % 8` of byte
    /// `i / 8`. A set bit is clickable. Build one through [`decode_bits_body`] or
    /// [`Shape::from_legacy`] so the length rule `bits.len() == ceil(w * h / 8)` holds; a shorter
    /// buffer built by hand still cannot panic, its missing bytes just miss.
    Bits { w: u32, h: u32, bits: Vec<u8> },
    /// The union of rectangles, each optionally clipped by a polygon (Webamp window rectangles and
    /// `region.txt` polygons, phase 2).
    Regions(Vec<Region>),
}

/// A clickable rectangle in skin pixels, optionally clipped by a polygon.
///
/// `poly` is a flat `[x0, y0, x1, y1, ...]` list in the same space as `x` and `y` (absolute, not
/// relative to the rectangle). A point hits when it is inside the rectangle and, if `poly` is
/// set, inside the polygon too (even-odd rule, so concave outlines work). A polygon with fewer
/// than 3 vertices, an odd coordinate count or a non-finite coordinate has no area and hits
/// nothing: Webamp drops such polygons from `region.txt` the same way.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub poly: Option<Vec<f64>>,
}

/// One window's entry: its shape (none until the page sends one) and the zoom that maps window
/// points to skin pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowHit {
    pub shape: Option<Shape>,
    pub zoom: f64,
}

/// Click-through state for every skin window, keyed by Tauri window label. Labels come from the
/// host (`skin-<sha12>-<n>`, D7.2), never from skin strings.
#[derive(Debug, Default)]
pub struct HitTable {
    windows: HashMap<String, WindowHit>,
    capture: Option<String>,
}

impl HitTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the label's shape and zoom wholesale.
    pub fn set_shape(&mut self, label: &str, shape: Shape, zoom: f64) {
        self.windows.insert(
            label.to_owned(),
            WindowHit {
                shape: Some(shape),
                zoom,
            },
        );
    }

    /// `on` makes `label` the capturing window, replacing any other: only one pointer drags at a
    /// time, and a release that never arrived (a cancelled pointer) heals at the next press.
    /// `off` clears the capture only if `label` holds it, so B releasing never drops A's drag.
    pub fn set_capture(&mut self, label: &str, on: bool) {
        if on {
            self.capture = Some(label.to_owned());
        } else if self.capture.as_deref() == Some(label) {
            self.capture = None;
        }
    }

    /// Drops the label's entry and any capture it held. Unknown labels are a no-op.
    pub fn remove(&mut self, label: &str) {
        self.windows.remove(label);
        if self.capture.as_deref() == Some(label) {
            self.capture = None;
        }
    }

    /// Whether the window should ignore the cursor at `(x, y)`, in window-local logical pixels.
    ///
    /// Clickable (`false`) when the label holds the capture, has no shape yet (so the page can
    /// load) or is unknown. A shape with an unusable zoom also fails open: dividing by it would
    /// miss everywhere and strand the window unreachable.
    pub fn want_ignore(&self, label: &str, x: f64, y: f64) -> bool {
        if self.capture.as_deref() == Some(label) {
            return false;
        }
        let Some(WindowHit {
            shape: Some(shape),
            zoom,
        }) = self.windows.get(label)
        else {
            return false;
        };
        if !(zoom.is_finite() && *zoom > 0.0) {
            return false;
        }
        !shape.hit(x / zoom, y / zoom)
    }

    /// The labels that have a table entry, for the poll thread to iterate.
    pub fn labels(&self) -> impl Iterator<Item = &str> {
        self.windows.keys().map(String::as_str)
    }

    pub fn window(&self, label: &str) -> Option<&WindowHit> {
        self.windows.get(label)
    }
}

impl Shape {
    /// A mask from the legacy `set_hit_mask(width, height, bits, zoom)` command, whose bits arrive
    /// as a JSON number array. Same layout and same length rule as [`decode_bits_body`], so both
    /// paths yield an identical `Shape` for the same mask.
    pub fn from_legacy(width: usize, height: usize, bits: Vec<u8>) -> Result<Shape, String> {
        let w = u32::try_from(width).map_err(|_| format!("mask width {width} out of range"))?;
        let h = u32::try_from(height).map_err(|_| format!("mask height {height} out of range"))?;
        check_bits_len(w, h, bits.len())?;
        Ok(Shape::Bits { w, h, bits })
    }

    /// `x`, `y` are in skin pixels (window points already divided by zoom).
    fn hit(&self, x: f64, y: f64) -> bool {
        match self {
            Shape::Bits { w, h, bits } => bits_hit(*w, *h, bits, x, y),
            Shape::Regions(regions) => regions.iter().any(|r| r.contains(x, y)),
        }
    }
}

/// Floor, not truncation, so a point just left of or above the mask is out of range rather than
/// pixel 0. The range test is written positively so NaN fails it.
fn bits_hit(w: u32, h: u32, bits: &[u8], x: f64, y: f64) -> bool {
    let (x, y) = (x.floor(), y.floor());
    if !(x >= 0.0 && x < f64::from(w) && y >= 0.0 && y < f64::from(h)) {
        return false;
    }
    let i = y as u64 * u64::from(w) + x as u64;
    usize::try_from(i / 8)
        .ok()
        .and_then(|byte| bits.get(byte))
        .is_some_and(|b| (b >> (i % 8)) & 1 == 1)
}

impl Region {
    /// The continuous point, not a floored pixel: polygon vertices are pixel corners, and the
    /// rectangle is half-open (`x <= px < x + w`) so abutting regions do not double-claim an edge.
    fn contains(&self, px: f64, py: f64) -> bool {
        if !(px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h) {
            return false;
        }
        match &self.poly {
            None => true,
            Some(poly) => polygon_contains(poly, px, py),
        }
    }
}

/// Even-odd ray casting over a flat `[x0, y0, x1, y1, ...]` vertex list.
fn polygon_contains(poly: &[f64], px: f64, py: f64) -> bool {
    let n = poly.len() / 2;
    if n * 2 != poly.len() || n < 3 || poly.iter().any(|v| !v.is_finite()) {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[2 * i], poly[2 * i + 1]);
        let (xj, yj) = (poly[2 * j], poly[2 * j + 1]);
        // The edge straddles the point's row, and the point is left of where it crosses it.
        if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// The one length rule for bit masks: non-empty, and exactly `ceil(w * h / 8)` bytes. `u64` so
/// that `w * h` cannot overflow, and it takes a length so a bad body is refused before any copy.
fn check_bits_len(w: u32, h: u32, len: usize) -> Result<(), String> {
    if w == 0 || h == 0 {
        // Nothing would be clickable, which strands the window.
        return Err(format!("hit mask is empty ({w}x{h})"));
    }
    let expected = (u64::from(w) * u64::from(h)).div_ceil(8);
    let len = len as u64;
    if len < expected {
        Err(format!(
            "hit mask {w}x{h} is truncated: {len} of {expected} bytes"
        ))
    } else if len > expected {
        Err(format!(
            "hit mask {w}x{h} has {} trailing bytes ({len} for {expected})",
            len - expected
        ))
    } else {
        Ok(())
    }
}

/// Decodes the raw `hit_set_bits` request body into a shape and its zoom.
///
/// Layout, all little-endian: bytes 0..4 `u32` width, 4..8 `u32` height, 8..16 `f64` zoom, then
/// the mask as 1 bit per skin pixel, row-major, LSB first, exactly `ceil(w * h / 8)` bytes.
/// Rejects a body shorter than the header, a zero width or height, a zoom that is not finite and
/// positive, and a bit length that does not match `w × h` (short or long).
pub fn decode_bits_body(body: &[u8]) -> Result<(Shape, f64), String> {
    if body.len() < BITS_HEADER_LEN {
        return Err(format!(
            "hit bits body is truncated: {} bytes, the header needs {BITS_HEADER_LEN}",
            body.len()
        ));
    }
    let (head, bits) = body.split_at(BITS_HEADER_LEN);
    // The slices are exactly 4 and 8 bytes long, so the conversions cannot fail.
    let w = u32::from_le_bytes(head[0..4].try_into().unwrap());
    let h = u32::from_le_bytes(head[4..8].try_into().unwrap());
    let zoom = f64::from_le_bytes(head[8..16].try_into().unwrap());
    if !(zoom.is_finite() && zoom > 0.0) {
        return Err(format!("hit zoom must be finite and positive, got {zoom}"));
    }
    check_bits_len(w, h, bits.len())?;
    Ok((
        Shape::Bits {
            w,
            h,
            bits: bits.to_vec(),
        },
        zoom,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mask with exactly the given (x, y) pixels set, in the documented bit layout.
    fn mask(w: u32, h: u32, set: &[(u32, u32)]) -> Shape {
        let mut bits = vec![0u8; (u64::from(w) * u64::from(h)).div_ceil(8) as usize];
        for &(x, y) in set {
            let i = y * w + x;
            bits[(i / 8) as usize] |= 1 << (i % 8);
        }
        Shape::Bits { w, h, bits }
    }

    fn body(w: u32, h: u32, zoom: f64, bits: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
        b.extend_from_slice(&zoom.to_le_bytes());
        b.extend_from_slice(bits);
        b
    }

    fn rect(x: f64, y: f64, w: f64, h: f64) -> Region {
        Region {
            x,
            y,
            w,
            h,
            poly: None,
        }
    }

    fn table(label: &str, shape: Shape, zoom: f64) -> HitTable {
        let mut t = HitTable::new();
        t.set_shape(label, shape, zoom);
        t
    }

    // ---- bits -----------------------------------------------------------------------------

    #[test]
    fn bits_hit_at_zoom_1() {
        let t = table("a", mask(4, 4, &[(2, 1)]), 1.0);
        assert!(!t.want_ignore("a", 2.0, 1.0), "the set pixel is clickable");
        assert!(!t.want_ignore("a", 2.99, 1.99), "anywhere inside the pixel");
        assert!(
            t.want_ignore("a", 1.99, 1.0),
            "left neighbour is transparent"
        );
        assert!(
            t.want_ignore("a", 3.0, 1.0),
            "right neighbour is transparent"
        );
        assert!(t.want_ignore("a", 2.0, 0.99), "pixel above is transparent");
        assert!(t.want_ignore("a", 2.0, 2.0), "pixel below is transparent");
    }

    #[test]
    fn bits_hit_at_zoom_1_5_floors_x_over_zoom() {
        let t = table("a", mask(4, 4, &[(2, 1)]), 1.5);
        // Pixel 2 spans window points [3.0, 4.5) horizontally and pixel 1 spans [1.5, 3.0).
        assert!(!t.want_ignore("a", 3.0, 1.5), "3.0 / 1.5 = 2.0");
        assert!(
            !t.want_ignore("a", 4.49, 2.99),
            "4.49 / 1.5 = 2.99, still pixel 2"
        );
        assert!(t.want_ignore("a", 4.5, 2.0), "4.5 / 1.5 = 3.0 is pixel 3");
        assert!(
            t.want_ignore("a", 2.99, 2.0),
            "2.99 / 1.5 = 1.99 is pixel 1, not rounded up"
        );
        assert!(
            t.want_ignore("a", 3.5, 3.0),
            "3.0 / 1.5 = 2.0 on y is row 2"
        );
        assert!(
            t.want_ignore("a", 3.5, 1.49),
            "1.49 / 1.5 = 0.99 is row 0, not rounded up"
        );
    }

    #[test]
    fn bits_are_row_major_lsb_first() {
        // 5 wide, so rows straddle byte boundaries: pixel i = y * 5 + x.
        for y in 0..3u32 {
            for x in 0..5u32 {
                let shape = mask(5, 3, &[(x, y)]);
                let i = y * 5 + x;
                if let Shape::Bits { bits, .. } = &shape {
                    assert_eq!(bits[(i / 8) as usize], 1 << (i % 8));
                }
                let t = table("a", shape, 1.0);
                for py in 0..3u32 {
                    for px in 0..5u32 {
                        let want = (px, py) == (x, y);
                        assert_eq!(
                            !t.want_ignore("a", f64::from(px), f64::from(py)),
                            want,
                            "set ({x},{y}) probed ({px},{py})"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn bits_out_of_range_is_a_miss() {
        let t = table("a", mask(4, 4, &[(0, 0), (3, 3)]), 1.0);
        assert!(!t.want_ignore("a", 0.0, 0.0));
        assert!(!t.want_ignore("a", 3.99, 3.99));
        for (x, y) in [
            (-0.01, 0.0),
            (0.0, -0.01),
            (-1.0, -1.0),
            (4.0, 3.0),
            (3.0, 4.0),
            (400.0, 0.0),
            (f64::NAN, 0.0),
            (0.0, f64::NAN),
            (f64::INFINITY, 0.0),
            (f64::NEG_INFINITY, 0.0),
        ] {
            assert!(t.want_ignore("a", x, y), "({x}, {y}) is outside the mask");
        }
    }

    #[test]
    fn bits_at_the_reference_size_760x394() {
        // 760 x 394 is 37,430 bytes (parity 3.3), with a partial last byte.
        let bits = vec![0xFF; 37_430];
        let shape = Shape::from_legacy(760, 394, bits).expect("reference size");
        let t = table("a", shape, 1.0);
        assert!(!t.want_ignore("a", 759.0, 393.0));
        assert!(t.want_ignore("a", 760.0, 393.0));
        assert!(t.want_ignore("a", 759.0, 394.0));
        let t = table("a", t.window("a").unwrap().shape.clone().unwrap(), 1.5);
        assert!(!t.want_ignore("a", 1139.9, 590.9));
        assert!(t.want_ignore("a", 1140.0, 0.0));
        assert!(t.want_ignore("a", 0.0, 591.0));
    }

    #[test]
    fn bits_shorter_than_declared_miss_instead_of_panicking() {
        let t = table(
            "a",
            Shape::Bits {
                w: 16,
                h: 16,
                bits: vec![0xFF],
            },
            1.0,
        );
        assert!(
            !t.want_ignore("a", 7.0, 0.0),
            "the one byte present covers x 0..8 of row 0"
        );
        assert!(t.want_ignore("a", 8.0, 0.0));
        assert!(t.want_ignore("a", 15.0, 15.0));
    }

    // ---- regions --------------------------------------------------------------------------

    #[test]
    fn regions_rect_is_half_open() {
        let t = table("a", Shape::Regions(vec![rect(10.0, 20.0, 30.0, 40.0)]), 1.0);
        assert!(!t.want_ignore("a", 10.0, 20.0), "top-left corner is in");
        assert!(!t.want_ignore("a", 39.99, 59.99));
        assert!(t.want_ignore("a", 40.0, 30.0), "x + w is out");
        assert!(t.want_ignore("a", 20.0, 60.0), "y + h is out");
        assert!(t.want_ignore("a", 9.99, 30.0));
        assert!(t.want_ignore("a", 20.0, 19.99));
    }

    #[test]
    fn regions_are_a_union_and_follow_zoom() {
        let shape = Shape::Regions(vec![
            rect(0.0, 0.0, 10.0, 10.0),
            rect(20.0, 0.0, 10.0, 10.0),
        ]);
        let t = table("a", shape, 2.0);
        assert!(
            !t.want_ignore("a", 19.0, 19.0),
            "(9.5, 9.5) is in the first rect"
        );
        assert!(
            t.want_ignore("a", 21.0, 5.0),
            "(10.5, 2.5) is between the rects"
        );
        assert!(
            !t.want_ignore("a", 41.0, 5.0),
            "(20.5, 2.5) is in the second rect"
        );
        assert!(t.want_ignore("a", 61.0, 5.0), "(30.5, 2.5) is past both");
    }

    #[test]
    fn regions_concave_polygon() {
        // A U: two 10-wide arms joined by a bridge along the top, with a notch between them.
        let u = Region {
            poly: Some(vec![
                0.0, 0.0, 30.0, 0.0, 30.0, 30.0, 20.0, 30.0, 20.0, 10.0, 10.0, 10.0, 10.0, 30.0,
                0.0, 30.0,
            ]),
            ..rect(0.0, 0.0, 30.0, 30.0)
        };
        let t = table("a", Shape::Regions(vec![u]), 1.0);
        assert!(!t.want_ignore("a", 5.0, 20.0), "left arm");
        assert!(!t.want_ignore("a", 25.0, 20.0), "right arm");
        assert!(!t.want_ignore("a", 15.0, 5.0), "bridge");
        assert!(!t.want_ignore("a", 15.0, 9.5), "just above the notch");
        assert!(t.want_ignore("a", 15.0, 10.5), "just inside the notch");
        assert!(
            t.want_ignore("a", 15.0, 25.0),
            "deep in the notch, inside the bounding box"
        );
        assert!(t.want_ignore("a", 35.0, 5.0), "outside the bounding box");
    }

    #[test]
    fn regions_polygon_is_absolute_and_clipped_by_its_rect() {
        // Triangle with its right angle at the rect's top-left corner (100, 50).
        let tri = Region {
            poly: Some(vec![100.0, 50.0, 130.0, 50.0, 100.0, 80.0]),
            ..rect(100.0, 50.0, 30.0, 30.0)
        };
        let t = table("a", Shape::Regions(vec![tri]), 1.0);
        assert!(!t.want_ignore("a", 105.0, 55.0), "inside the triangle");
        assert!(
            t.want_ignore("a", 125.0, 75.0),
            "in the rect, past the hypotenuse"
        );
        assert!(
            t.want_ignore("a", 5.0, 5.0),
            "the polygon's numbers are not rect-relative"
        );

        // A polygon that spills outside its rect is still cut off by the rect.
        let spill = Region {
            poly: Some(vec![0.0, 0.0, 100.0, 0.0, 100.0, 100.0, 0.0, 100.0]),
            ..rect(10.0, 10.0, 10.0, 10.0)
        };
        let t = table("a", Shape::Regions(vec![spill]), 1.0);
        assert!(!t.want_ignore("a", 15.0, 15.0));
        assert!(t.want_ignore("a", 50.0, 50.0));
    }

    #[test]
    fn regions_degenerate_polygons_hit_nothing() {
        for poly in [
            vec![],
            vec![0.0, 0.0],
            vec![0.0, 0.0, 10.0, 10.0],
            vec![0.0, 0.0, 10.0, 0.0, 10.0],
            vec![0.0, 0.0, 10.0, 0.0, f64::NAN, 10.0, 0.0, 10.0],
        ] {
            let r = Region {
                poly: Some(poly.clone()),
                ..rect(0.0, 0.0, 10.0, 10.0)
            };
            let t = table("a", Shape::Regions(vec![r]), 1.0);
            assert!(t.want_ignore("a", 5.0, 5.0), "poly {poly:?}");
        }
    }

    #[test]
    fn regions_unusable_rects_hit_nothing() {
        let shape = Shape::Regions(vec![
            rect(0.0, 0.0, -10.0, 10.0),
            rect(0.0, 0.0, 10.0, 0.0),
            rect(f64::NAN, 0.0, 10.0, 10.0),
        ]);
        let t = table("a", shape, 1.0);
        assert!(t.want_ignore("a", 5.0, 5.0));
        assert!(t.want_ignore("a", -5.0, 5.0));
        let t = table("a", Shape::Regions(vec![]), 1.0);
        assert!(
            t.want_ignore("a", 5.0, 5.0),
            "an empty list claims no pixels"
        );
    }

    #[test]
    fn region_deserializes_with_or_without_poly() {
        let plain: Region = serde_json::from_str(r#"{"x":1,"y":2,"w":3,"h":4}"#).unwrap();
        assert_eq!(plain, rect(1.0, 2.0, 3.0, 4.0));
        let null: Region =
            serde_json::from_str(r#"{"x":1,"y":2,"w":3,"h":4,"poly":null}"#).unwrap();
        assert_eq!(null, plain);
        let poly: Region =
            serde_json::from_str(r#"{"x":0,"y":0,"w":9,"h":9,"poly":[0,0,9,0,0,9]}"#).unwrap();
        assert_eq!(poly.poly, Some(vec![0.0, 0.0, 9.0, 0.0, 0.0, 9.0]));
        let again: Region = serde_json::from_str(&serde_json::to_string(&poly).unwrap()).unwrap();
        assert_eq!(again, poly);
    }

    // ---- want_ignore ----------------------------------------------------------------------

    #[test]
    fn want_ignore_with_no_shape_is_clickable() {
        let mut t = HitTable::new();
        assert!(!t.want_ignore("never-seen", 5.0, 5.0), "unknown label");
        t.windows.insert(
            "empty".into(),
            WindowHit {
                shape: None,
                zoom: 1.0,
            },
        );
        assert!(
            !t.want_ignore("empty", 5.0, 5.0),
            "registered, no shape yet"
        );
        assert!(!t.want_ignore("empty", -5.0, 1e9), "and nowhere is a miss");
        t.set_shape("empty", mask(2, 2, &[]), 1.0);
        assert!(
            t.want_ignore("empty", 1.0, 1.0),
            "once a shape arrives it applies"
        );
    }

    #[test]
    fn want_ignore_fails_open_on_an_unusable_zoom() {
        for zoom in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let t = table("a", mask(2, 2, &[(0, 0)]), zoom);
            assert!(
                !t.want_ignore("a", 1.5, 1.5),
                "zoom {zoom} must not strand the window"
            );
        }
    }

    #[test]
    fn set_shape_replaces_per_label_and_keeps_labels_apart() {
        let mut t = HitTable::new();
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_shape("b", mask(4, 4, &[(3, 3)]), 1.0);
        assert!(!t.want_ignore("a", 0.0, 0.0));
        assert!(t.want_ignore("a", 3.0, 3.0));
        assert!(!t.want_ignore("b", 3.0, 3.0));
        assert!(t.want_ignore("b", 0.0, 0.0));

        t.set_shape("a", mask(4, 4, &[(3, 3)]), 2.0);
        assert!(t.want_ignore("a", 0.0, 0.0), "the old shape is gone");
        assert!(!t.want_ignore("a", 6.0, 6.0), "and the new zoom applies");
        assert!(t.want_ignore("b", 0.0, 0.0), "b is untouched");
        assert_eq!(t.window("a").unwrap().zoom, 2.0);
        let mut labels: Vec<_> = t.labels().collect();
        labels.sort_unstable();
        assert_eq!(labels, ["a", "b"]);
    }

    // ---- capture --------------------------------------------------------------------------

    #[test]
    fn capture_is_per_label() {
        let mut t = HitTable::new();
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_shape("b", mask(4, 4, &[(0, 0)]), 1.0);
        assert!(t.want_ignore("a", 3.0, 3.0));
        assert!(t.want_ignore("b", 3.0, 3.0));

        t.set_capture("a", true);
        assert!(
            !t.want_ignore("a", 3.0, 3.0),
            "A is never ignoring while it captures"
        );
        assert!(!t.want_ignore("a", -50.0, 900.0), "even far off the skin");
        assert!(t.want_ignore("b", 3.0, 3.0), "B still follows its mask");
        assert!(!t.want_ignore("b", 0.0, 0.0));

        t.set_capture("a", false);
        assert!(
            t.want_ignore("a", 3.0, 3.0),
            "released: A follows its mask again"
        );
    }

    #[test]
    fn capture_survives_another_label_releasing() {
        let mut t = HitTable::new();
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_shape("b", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_capture("a", true);
        t.set_capture("b", false);
        assert!(
            !t.want_ignore("a", 3.0, 3.0),
            "B's release does not drop A's capture"
        );
        t.set_capture("a", false);
        t.set_capture("a", false);
        assert!(t.want_ignore("a", 3.0, 3.0), "releasing twice is harmless");
    }

    #[test]
    fn capture_moves_to_the_latest_presser() {
        let mut t = HitTable::new();
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_shape("b", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_capture("a", true);
        t.set_capture("b", true);
        assert!(t.want_ignore("a", 3.0, 3.0), "a stale capture is replaced");
        assert!(!t.want_ignore("b", 3.0, 3.0));
    }

    #[test]
    fn capture_works_before_a_shape_exists() {
        let mut t = HitTable::new();
        t.set_capture("a", true);
        t.set_shape("a", mask(4, 4, &[]), 1.0);
        assert!(
            !t.want_ignore("a", 1.0, 1.0),
            "the capture was already in force"
        );
        assert_eq!(t.labels().count(), 1, "capture alone registers nothing");
    }

    #[test]
    fn remove_drops_a_label_and_the_capture_it_held() {
        let mut t = HitTable::new();
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_capture("a", true);
        t.remove("a");
        assert!(t.window("a").is_none());
        assert!(!t.want_ignore("a", 3.0, 3.0), "no entry: clickable");
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        assert!(
            t.want_ignore("a", 3.0, 3.0),
            "a re-registered window does not inherit the capture"
        );
    }

    #[test]
    fn remove_leaves_other_labels_and_their_capture() {
        let mut t = HitTable::new();
        t.set_shape("a", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_shape("b", mask(4, 4, &[(0, 0)]), 1.0);
        t.set_capture("a", true);
        t.remove("b");
        t.remove("never-seen");
        assert!(!t.want_ignore("a", 3.0, 3.0), "A keeps its capture");
        assert!(t.window("b").is_none());
        assert!(t.window("a").is_some());
    }

    #[test]
    fn host_labels_are_plain_strings() {
        // Labels are host-assigned, not skin strings, but the table treats odd ones as plain keys.
        let mut t = HitTable::new();
        t.set_shape("__proto__", mask(2, 2, &[(0, 0)]), 1.0);
        assert!(
            !t.want_ignore("constructor", 0.0, 0.0),
            "unknown stays clickable"
        );
        assert!(!t.want_ignore("__proto__", 0.0, 0.0));
        assert!(t.want_ignore("__proto__", 1.0, 1.0));
    }

    // ---- decode_bits_body -----------------------------------------------------------------

    #[test]
    fn decode_reads_shape_and_zoom() {
        let (shape, zoom) =
            decode_bits_body(&body(4, 4, 1.5, &[0b0000_0100, 0b0000_0000])).unwrap();
        assert_eq!(zoom, 1.5);
        assert_eq!(shape, mask(4, 4, &[(2, 0)]));
        let t = table("a", shape, zoom);
        assert!(
            !t.want_ignore("a", 3.0, 0.0),
            "pixel (2, 0) is at window x 3.0 under zoom 1.5"
        );
    }

    #[test]
    fn decode_header_is_little_endian_u32_u32_f64() {
        // 3 x 2 at zoom 1.0 (0x3FF0_0000_0000_0000), hand-assembled so the layout is pinned
        // independently of the `body` helper.
        let bytes = [
            3,
            0,
            0,
            0, // width
            2,
            0,
            0,
            0, // height
            0,
            0,
            0,
            0,
            0,
            0,
            0xF0,
            0x3F,        // zoom
            0b0010_0001, // 6 bits: (0, 0) and (2, 1)
        ];
        let (shape, zoom) = decode_bits_body(&bytes).unwrap();
        assert_eq!(zoom, 1.0);
        assert_eq!(shape, mask(3, 2, &[(0, 0), (2, 1)]));
    }

    #[test]
    fn decode_rejects_a_truncated_header() {
        let full = body(8, 8, 1.0, &[0u8; 8]);
        for len in 0..BITS_HEADER_LEN {
            let err = decode_bits_body(&full[..len]).unwrap_err();
            assert!(err.contains("truncated"), "{len} bytes: {err}");
        }
    }

    #[test]
    fn decode_rejects_truncated_bits() {
        let err = decode_bits_body(&body(8, 8, 1.0, &[0u8; 7])).unwrap_err();
        assert!(err.contains("truncated"), "{err}");
        let err = decode_bits_body(&body(8, 8, 1.0, &[])).unwrap_err();
        assert!(err.contains("truncated"), "{err}");
        // 760 x 394 needs 37,430 bytes; one short is not enough.
        assert!(decode_bits_body(&body(760, 394, 1.0, &vec![0xFF; 37_429])).is_err());
        assert!(decode_bits_body(&body(760, 394, 1.0, &vec![0xFF; 37_430])).is_ok());
    }

    #[test]
    fn decode_rejects_a_bit_length_that_does_not_match_w_times_h() {
        // Trailing bytes.
        let err = decode_bits_body(&body(8, 8, 1.0, &[0u8; 9])).unwrap_err();
        assert!(err.contains("trailing"), "{err}");
        // The header claims 3x3 = 9 bits = 2 bytes; a transposed 4x4 payload is 2 bytes too, but
        // a 4x5 payload is 3.
        assert!(decode_bits_body(&body(3, 3, 1.0, &[0u8; 2])).is_ok());
        assert!(decode_bits_body(&body(3, 3, 1.0, &[0u8; 3])).is_err());
        // The same bytes under a different declared size.
        assert!(decode_bits_body(&body(4, 5, 1.0, &[0u8; 2])).is_err());
        assert!(decode_bits_body(&body(4, 5, 1.0, &[0u8; 3])).is_ok());
        // Rounding up: 1 bit is 1 byte, 9 bits are 2.
        assert!(decode_bits_body(&body(1, 1, 1.0, &[1])).is_ok());
        assert!(decode_bits_body(&body(1, 1, 1.0, &[])).is_err());
        assert!(decode_bits_body(&body(9, 1, 1.0, &[0xFF])).is_err());
        assert!(decode_bits_body(&body(9, 1, 1.0, &[0xFF, 1])).is_ok());
    }

    #[test]
    fn decode_does_not_trust_huge_dimensions() {
        // w * h overflows u32 and nearly overflows u64; the body is a few bytes. No allocation,
        // no panic, a plain error.
        let err = decode_bits_body(&body(u32::MAX, u32::MAX, 1.0, &[0xFF; 4])).unwrap_err();
        assert!(err.contains("truncated"), "{err}");
        assert!(decode_bits_body(&body(u32::MAX, 1, 1.0, &[0xFF; 4])).is_err());
    }

    #[test]
    fn decode_rejects_an_empty_mask() {
        assert!(decode_bits_body(&body(0, 4, 1.0, &[])).is_err());
        assert!(decode_bits_body(&body(4, 0, 1.0, &[])).is_err());
        assert!(decode_bits_body(&body(0, 0, 1.0, &[])).is_err());
    }

    #[test]
    fn decode_rejects_an_unusable_zoom() {
        for zoom in [0.0, -1.0, -0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let err = decode_bits_body(&body(2, 2, zoom, &[0])).unwrap_err();
            assert!(err.contains("zoom"), "zoom {zoom}: {err}");
        }
    }

    // ---- legacy ---------------------------------------------------------------------------

    #[test]
    fn legacy_json_mask_converts_to_the_same_shape() {
        // The legacy command receives `bits` as a JSON number array and `width`/`height` as usize.
        let json = "[4,0,255,16,1]";
        let legacy: Vec<u8> = serde_json::from_str(json).unwrap();
        let from_legacy = Shape::from_legacy(8, 5, legacy.clone()).unwrap();
        let (from_body, zoom) = decode_bits_body(&body(8, 5, 1.0, &legacy)).unwrap();
        assert_eq!(zoom, 1.0);
        assert_eq!(from_legacy, from_body);

        // And it behaves identically: row 2 (bits 16..24) is all set, row 0 has x = 2 set.
        let t = table("a", from_legacy, 1.0);
        assert!(!t.want_ignore("a", 2.0, 0.0));
        assert!(t.want_ignore("a", 3.0, 0.0));
        assert!(!t.want_ignore("a", 0.0, 2.0));
        assert!(!t.want_ignore("a", 7.0, 2.0));
        assert!(!t.want_ignore("a", 4.0, 3.0));
        assert!(!t.want_ignore("a", 0.0, 4.0));
    }

    #[test]
    fn legacy_rejects_what_decode_rejects() {
        assert!(Shape::from_legacy(8, 8, vec![0; 7]).is_err(), "short");
        assert!(Shape::from_legacy(8, 8, vec![0; 9]).is_err(), "long");
        assert!(Shape::from_legacy(0, 8, vec![]).is_err(), "empty");
        assert!(
            Shape::from_legacy(usize::MAX, 1, vec![0; 4]).is_err(),
            "width past u32"
        );
        assert!(Shape::from_legacy(8, 8, vec![0; 8]).is_ok());
    }
}
