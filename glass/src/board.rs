//! Who drew what on the shared screen, and what is still visible. A port of `DrawBoard` in
//! src/web/rtc/draw.ts, for one share: the same timings, so marks fade here as they do in the browser.

use std::collections::HashMap;

pub const STROKE_HOLD_MS: f64 = 2500.0;
pub const STROKE_FADE_MS: f64 = 800.0;
pub const POINTER_IDLE_MS: f64 = 5000.0;
pub const STROKE_STALL_MS: f64 = 10_000.0;
pub const MAX_STROKE_POINTS: usize = 4000;
pub const MAX_STROKES: usize = 64;
/** Rooms hold at most 10 members. */
pub const MAX_AUTHORS: usize = 16;

/// One draw message, as the browser's `DrawMessage` without its share id. Coordinates are 0–1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark {
    Move { x: f32, y: f32 },
    Down { x: f32, y: f32 },
    Line { x: f32, y: f32 },
    Up,
    Leave,
    Clear,
}

struct Stroke {
    /// Flat x, y pairs.
    points: Vec<f32>,
    last_at: f64,
    ended_at: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    pub x: f32,
    pub y: f32,
    at: f64,
}

struct Marks {
    name: String,
    color: [u8; 3],
    pointer: Option<Pointer>,
    strokes: Vec<Stroke>,
}

pub struct VisibleStroke<'a> {
    pub points: &'a [f32],
    pub alpha: f32,
}

pub struct VisibleMarks<'a> {
    pub name: &'a str,
    pub color: [u8; 3],
    pub pointer: Option<(f32, f32)>,
    pub strokes: Vec<VisibleStroke<'a>>,
}

#[derive(Default)]
pub struct Board {
    authors: HashMap<String, Marks>,
}

impl Board {
    /// Returns false when the author would be one too many (the message is dropped).
    pub fn apply(&mut self, author: &str, name: &str, color: [u8; 3], mark: Mark, now: f64) -> bool {
        if !self.authors.contains_key(author) && self.authors.len() >= MAX_AUTHORS {
            return false;
        }
        let marks = self.authors.entry(author.to_owned()).or_insert_with(|| Marks {
            name: String::new(),
            color,
            pointer: None,
            strokes: Vec::new(),
        });
        if marks.name != name {
            marks.name = name.to_owned();
        }
        marks.color = color;
        let open = marks.strokes.last().is_some_and(|s| s.ended_at.is_none());
        match mark {
            Mark::Move { x, y } => marks.pointer = Some(Pointer { x, y, at: now }),
            Mark::Down { x, y } => {
                if open {
                    marks.strokes.last_mut().unwrap().ended_at = Some(now);
                }
                push_stroke(&mut marks.strokes, x, y, now);
                marks.pointer = Some(Pointer { x, y, at: now });
            }
            Mark::Line { x, y } => {
                if open {
                    let stroke = marks.strokes.last_mut().unwrap();
                    if stroke.points.len() < MAX_STROKE_POINTS * 2 {
                        stroke.points.extend([x, y]);
                        stroke.last_at = now;
                    }
                } else {
                    // The "down" went missing (joined mid-stroke): start from here.
                    push_stroke(&mut marks.strokes, x, y, now);
                }
                marks.pointer = Some(Pointer { x, y, at: now });
            }
            Mark::Up => {
                if open {
                    marks.strokes.last_mut().unwrap().ended_at = Some(now);
                }
            }
            Mark::Leave => {
                if open {
                    marks.strokes.last_mut().unwrap().ended_at = Some(now);
                }
                marks.pointer = None;
            }
            Mark::Clear => marks.strokes.clear(),
        }
        true
    }

    pub fn forget(&mut self, author: &str) {
        self.authors.remove(author);
    }

    pub fn clear(&mut self) {
        self.authors.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.authors.is_empty()
    }

    /// Drops whatever has faded out by `now`. Call before `visible`.
    pub fn prune(&mut self, now: f64) {
        self.authors.retain(|_, marks| {
            if marks.pointer.is_some_and(|p| now - p.at >= POINTER_IDLE_MS) {
                marks.pointer = None;
            }
            marks.strokes.retain(|s| stroke_alpha(s, now) > 0.0);
            marks.pointer.is_some() || !marks.strokes.is_empty()
        });
    }

    /// What to paint at `now`. `hide_pointer_of` is the sharer, whose real cursor is already on screen.
    pub fn visible(&self, now: f64, hide_pointer_of: Option<&str>) -> Vec<VisibleMarks<'_>> {
        let mut out: Vec<_> = self
            .authors
            .iter()
            .map(|(author, marks)| VisibleMarks {
                name: &marks.name,
                color: marks.color,
                pointer: marks.pointer.filter(|_| hide_pointer_of != Some(author.as_str())).map(|p| (p.x, p.y)),
                strokes: marks
                    .strokes
                    .iter()
                    .map(|s| VisibleStroke { points: &s.points, alpha: stroke_alpha(s, now) })
                    .filter(|s| s.alpha > 0.0)
                    .collect(),
            })
            .collect();
        // A stable paint order, so overlapping marks don't flicker between frames.
        out.sort_by(|a, b| a.name.cmp(b.name));
        out
    }
}

fn push_stroke(strokes: &mut Vec<Stroke>, x: f32, y: f32, now: f64) {
    strokes.push(Stroke { points: vec![x, y], last_at: now, ended_at: None });
    if strokes.len() > MAX_STROKES {
        strokes.remove(0);
    }
}

fn stroke_alpha(stroke: &Stroke, now: f64) -> f32 {
    let ended = stroke.ended_at.or_else(|| (now - stroke.last_at >= STROKE_STALL_MS).then_some(stroke.last_at));
    let Some(ended) = ended else { return 1.0 };
    let age = now - ended;
    if age < STROKE_HOLD_MS {
        return 1.0;
    }
    (1.0 - (age - STROKE_HOLD_MS) / STROKE_FADE_MS).max(0.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: [u8; 3] = [255, 0, 0];

    fn draw(board: &mut Board, author: &str, marks: &[Mark], now: f64) {
        for &m in marks {
            board.apply(author, author, C, m, now);
        }
    }

    #[test]
    fn a_stroke_holds_then_fades_out() {
        let mut b = Board::default();
        draw(&mut b, "a", &[Mark::Down { x: 0.1, y: 0.1 }, Mark::Line { x: 0.2, y: 0.2 }, Mark::Up], 0.0);
        let alpha = |b: &Board, t| b.visible(t, None)[0].strokes[0].alpha;
        assert_eq!(alpha(&b, STROKE_HOLD_MS - 1.0), 1.0);
        assert!((alpha(&b, STROKE_HOLD_MS + STROKE_FADE_MS / 2.0) - 0.5).abs() < 1e-6);
        b.prune(STROKE_HOLD_MS + STROKE_FADE_MS);
        // The pointer is still there until it idles out.
        assert!(b.visible(0.0, None)[0].strokes.is_empty());
        b.prune(POINTER_IDLE_MS);
        assert!(b.is_empty());
    }

    #[test]
    fn an_open_stroke_that_stalls_counts_as_finished() {
        let mut b = Board::default();
        draw(&mut b, "a", &[Mark::Down { x: 0.5, y: 0.5 }], 0.0);
        let t = STROKE_STALL_MS + STROKE_HOLD_MS + STROKE_FADE_MS;
        b.prune(t);
        assert!(b.is_empty());
    }

    #[test]
    fn line_without_down_starts_a_stroke() {
        let mut b = Board::default();
        draw(&mut b, "a", &[Mark::Line { x: 0.3, y: 0.4 }, Mark::Line { x: 0.5, y: 0.6 }], 0.0);
        assert_eq!(b.visible(0.0, None)[0].strokes[0].points, &[0.3, 0.4, 0.5, 0.6]);
    }

    #[test]
    fn the_sharers_pointer_is_hidden_but_its_strokes_show() {
        let mut b = Board::default();
        draw(&mut b, "me", &[Mark::Down { x: 0.1, y: 0.1 }, Mark::Line { x: 0.2, y: 0.2 }], 0.0);
        draw(&mut b, "you", &[Mark::Move { x: 0.9, y: 0.9 }], 0.0);
        let v = b.visible(0.0, Some("me"));
        let me = v.iter().find(|m| m.name == "me").unwrap();
        let you = v.iter().find(|m| m.name == "you").unwrap();
        assert_eq!(me.pointer, None);
        assert_eq!(me.strokes.len(), 1);
        assert_eq!(you.pointer, Some((0.9, 0.9)));
    }

    #[test]
    fn caps_strokes_points_and_authors() {
        let mut b = Board::default();
        for i in 0..MAX_STROKES + 5 {
            draw(&mut b, "a", &[Mark::Down { x: 0.0, y: i as f32 / 100.0 }, Mark::Up], 0.0);
        }
        assert_eq!(b.visible(0.0, None)[0].strokes.len(), MAX_STROKES);
        b.clear();
        draw(&mut b, "a", &[Mark::Down { x: 0.0, y: 0.0 }], 0.0);
        for _ in 0..MAX_STROKE_POINTS + 10 {
            draw(&mut b, "a", &[Mark::Line { x: 0.5, y: 0.5 }], 0.0);
        }
        assert_eq!(b.visible(0.0, None)[0].strokes[0].points.len(), MAX_STROKE_POINTS * 2);
        b.clear();
        for i in 0..MAX_AUTHORS {
            assert!(b.apply(&format!("m{i}"), "x", C, Mark::Move { x: 0.0, y: 0.0 }, 0.0));
        }
        assert!(!b.apply("one-too-many", "x", C, Mark::Move { x: 0.0, y: 0.0 }, 0.0));
    }

    #[test]
    fn clear_forget_and_leave() {
        let mut b = Board::default();
        draw(&mut b, "a", &[Mark::Down { x: 0.1, y: 0.1 }, Mark::Up, Mark::Clear], 0.0);
        assert!(b.visible(0.0, None)[0].strokes.is_empty());
        draw(&mut b, "a", &[Mark::Leave], 0.0);
        b.prune(0.0);
        assert!(b.is_empty());
        draw(&mut b, "a", &[Mark::Move { x: 0.1, y: 0.1 }], 0.0);
        b.forget("a");
        assert!(b.is_empty());
    }
}
