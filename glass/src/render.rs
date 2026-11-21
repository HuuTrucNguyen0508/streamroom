//! Paints the board the way src/web/ui/DrawLayer.tsx does: a dark edge under each colored stroke,
//! and each pointer as an arrow with a name pill.

use ab_glyph::{Font, FontVec, PxScale, ScaleFont};
use tiny_skia::{Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform};

use crate::board::VisibleMarks;

const EDGE: [u8; 4] = [10, 9, 20, 140]; // rgb(10 9 20 / 0.55)
const ARROW_EDGE: [u8; 4] = [10, 9, 20, 217]; // rgb(10 9 20 / 0.85)
const LABEL_TEXT: [u8; 3] = [0x15, 0x13, 0x2a];

pub struct Renderer {
    font: Option<FontVec>,
}

impl Renderer {
    pub fn new(font: Option<FontVec>) -> Self {
        Self { font }
    }

    /// Paints `marks` over a cleared `pixmap`. `scale` is device pixels per logical pixel.
    pub fn paint(&self, pixmap: &mut Pixmap, marks: &[VisibleMarks<'_>], scale: f32) {
        pixmap.fill(Color::TRANSPARENT);
        let (w, h) = (pixmap.width() as f32, pixmap.height() as f32);
        for m in marks {
            for s in &m.strokes {
                paint_stroke(pixmap, s.points, s.alpha, m.color, scale, w, h);
            }
        }
        // Pointers above every stroke, so a pointer is never hidden by someone's line.
        for m in marks {
            if let Some((x, y)) = m.pointer {
                self.paint_pointer(pixmap, x * w, y * h, m.color, m.name, scale);
            }
        }
    }

    fn paint_pointer(&self, pixmap: &mut Pixmap, x: f32, y: f32, color: [u8; 3], name: &str, scale: f32) {
        let t = Transform::from_scale(scale, scale).post_translate(x, y);
        let mut pb = PathBuilder::new();
        pb.move_to(0.0, 0.0);
        for (px, py) in [(0.0, 17.0), (4.5, 13.0), (7.5, 19.5), (10.5, 18.2), (7.6, 11.8), (13.0, 11.8)] {
            pb.line_to(px, py);
        }
        pb.close();
        let Some(arrow) = pb.finish() else { return };
        pixmap.fill_path(&arrow, &paint(rgba(color, 255)), FillRule::Winding, t, None);
        let edge = Stroke { width: 1.5, line_join: LineJoin::Round, ..Stroke::default() };
        pixmap.stroke_path(&arrow, &paint(ARROW_EDGE), &edge, t, None);

        let (Some(font), false) = (&self.font, name.is_empty()) else { return };
        let font = font.as_scaled(PxScale::from(12.0 * scale));
        let text_w: f32 = name.chars().map(|c| font.h_advance(font.glyph_id(c))).sum();
        let (pill_x, pill_y) = (x + 14.0 * scale, y + 16.0 * scale);
        let pill = rounded_rect(pill_x, pill_y, text_w + 14.0 * scale, 20.0 * scale, 10.0 * scale);
        if let Some(pill) = pill {
            pixmap.fill_path(&pill, &paint(rgba(color, 255)), FillRule::Winding, Transform::identity(), None);
        }
        // Centered on the pill's middle, as `textBaseline = "middle"` at y + 26.5 does.
        let baseline = y + 26.5 * scale + (font.ascent() + font.descent()) / 2.0;
        let mut pen = pill_x + 7.0 * scale;
        for c in name.chars() {
            let id = font.glyph_id(c);
            let glyph = id.with_scale_and_position(font.scale(), ab_glyph::point(pen, baseline));
            pen += font.h_advance(id);
            if let Some(outline) = font.outline_glyph(glyph) {
                let b = outline.px_bounds();
                outline.draw(|gx, gy, coverage| {
                    blend(pixmap, b.min.x as i32 + gx as i32, b.min.y as i32 + gy as i32, LABEL_TEXT, coverage);
                });
            }
        }
    }
}

fn paint_stroke(pixmap: &mut Pixmap, points: &[f32], alpha: f32, color: [u8; 3], scale: f32, w: f32, h: f32) {
    if points.len() < 2 {
        return;
    }
    let mut pb = PathBuilder::new();
    pb.move_to(points[0] * w, points[1] * h);
    // A lone point still shows as a dot.
    if points.len() == 2 {
        pb.line_to(points[0] * w + 0.01, points[1] * h);
    }
    for p in points[2..].as_chunks::<2>().0 {
        pb.line_to(p[0] * w, p[1] * h);
    }
    let Some(path) = pb.finish() else { return };
    let a = |base: u8| (base as f32 * alpha).round() as u8;
    let line = |width: f32| Stroke {
        width: width * scale,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Stroke::default()
    };
    pixmap.stroke_path(&path, &paint([EDGE[0], EDGE[1], EDGE[2], a(EDGE[3])]), &line(6.0), Transform::identity(), None);
    pixmap.stroke_path(&path, &paint(rgba(color, a(255))), &line(3.5), Transform::identity(), None);
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    let r = r.min(w / 2.0).min(h / 2.0);
    // Quarter circles from cubic Béziers.
    const K: f32 = 0.552_284_8;
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.cubic_to(x + w - r + K * r, y, x + w, y + r - K * r, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.cubic_to(x + w, y + h - r + K * r, x + w - r + K * r, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.cubic_to(x + r - K * r, y + h, x, y + h - r + K * r, x, y + h - r);
    pb.line_to(x, y + r);
    pb.cubic_to(x, y + r - K * r, x + r - K * r, y, x + r, y);
    pb.close();
    Rect::from_xywh(x, y, w, h)?;
    pb.finish()
}

fn rgba([r, g, b]: [u8; 3], a: u8) -> [u8; 4] {
    [r, g, b, a]
}

fn paint(c: [u8; 4]) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color_rgba8(c[0], c[1], c[2], c[3]);
    p.anti_alias = true;
    p
}

/// Source-over one opaque-colored pixel with `coverage` onto the premultiplied pixmap.
fn blend(pixmap: &mut Pixmap, x: i32, y: i32, [r, g, b]: [u8; 3], coverage: f32) {
    let (w, h) = (pixmap.width() as i32, pixmap.height() as i32);
    if x < 0 || y < 0 || x >= w || y >= h || coverage <= 0.0 {
        return;
    }
    let a = coverage.min(1.0);
    let i = (y * w + x) as usize * 4;
    let px = &mut pixmap.data_mut()[i..i + 4];
    for (dst, src) in px.iter_mut().zip([r, g, b, 255]) {
        *dst = (src as f32 * a + *dst as f32 * (1.0 - a)).round() as u8;
    }
}

/// The system's UI font, for name labels. None means pills without names.
pub fn system_font() -> Option<FontVec> {
    font_paths().into_iter().find_map(|path| FontVec::try_from_vec(std::fs::read(path).ok()?).ok())
}

#[cfg(target_os = "linux")]
fn font_paths() -> Vec<std::path::PathBuf> {
    let out = std::process::Command::new("fc-match").args(["-f", "%{file}", "sans-serif:weight=semibold"]).output();
    out.ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|p| vec![p.into()])
        .unwrap_or_default()
}

#[cfg(windows)]
fn font_paths() -> Vec<std::path::PathBuf> {
    let fonts =
        std::env::var_os("WINDIR").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into()).join("Fonts");
    vec![fonts.join("seguisb.ttf"), fonts.join("segoeui.ttf")]
}

#[cfg(not(any(target_os = "linux", windows)))]
fn font_paths() -> Vec<std::path::PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::{Board, Mark};

    fn alpha_at(p: &Pixmap, x: u32, y: u32) -> u8 {
        p.pixel(x, y).unwrap().alpha()
    }

    #[test]
    fn paints_strokes_and_pointers_where_the_fractions_say() {
        let mut board = Board::default();
        let c = [0xef, 0x6f, 0x5e];
        for m in [Mark::Down { x: 0.25, y: 0.5 }, Mark::Line { x: 0.75, y: 0.5 }, Mark::Up] {
            board.apply("someone1", "Sam", c, m, 0.0);
        }
        board.apply("other111", "Ola", c, Mark::Move { x: 0.1, y: 0.1 }, 0.0);
        let mut pixmap = Pixmap::new(400, 200).unwrap();
        Renderer::new(system_font()).paint(&mut pixmap, &board.visible(0.0, None), 1.0);
        // On the line, fully colored; well off it, untouched.
        let on = pixmap.pixel(200, 100).unwrap();
        assert_eq!((on.red(), on.green(), on.blue(), on.alpha()), (0xef, 0x6f, 0x5e, 255));
        assert_eq!(alpha_at(&pixmap, 200, 150), 0);
        assert_eq!(alpha_at(&pixmap, 50, 100), 0);
        // The arrow's tip sits at the pointer's spot (40, 20) and points down-right.
        assert!(alpha_at(&pixmap, 42, 30) > 0);
        assert_eq!(alpha_at(&pixmap, 36, 16), 0);
    }

    #[test]
    fn fading_strokes_get_lighter_and_cleared_pixels_stay_clear() {
        let mut board = Board::default();
        for m in [Mark::Down { x: 0.5, y: 0.5 }, Mark::Line { x: 0.6, y: 0.5 }, Mark::Up, Mark::Leave] {
            board.apply("someone1", "", [255, 255, 255], m, 0.0);
        }
        let mut pixmap = Pixmap::new(100, 100).unwrap();
        let r = Renderer::new(None);
        r.paint(&mut pixmap, &board.visible(2900.0, None), 1.0);
        let fading = alpha_at(&pixmap, 55, 50);
        assert!(fading > 0 && fading < 255, "{fading}");
        board.prune(4000.0);
        r.paint(&mut pixmap, &board.visible(4000.0, None), 1.0);
        assert!(pixmap.data().iter().all(|&b| b == 0));
    }
}
