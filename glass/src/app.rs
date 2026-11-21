//! What the overlay should show, from what the tab said. Platform backends feed it events and ask
//! where to draw; they own the window and the pixels.

use crate::board::Board;
use crate::monitor::{self, Output, Pick};
use crate::protocol::{self, Inbound};
use crate::server::Event;

#[derive(Clone, Debug, PartialEq)]
pub struct Share {
    pub generation: u32,
    pub me: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Default)]
pub struct App {
    pub board: Board,
    /// The connected tab.
    pub conn: Option<u64>,
    pub share: Option<Share>,
    /// `--output`.
    pub wanted: Option<String>,
    /// The last status sent, so each share's status goes out once.
    sent: Option<(u64, u32, String)>,
}

/// Where the current share should be drawn.
#[derive(Debug, PartialEq)]
pub enum Target<'a> {
    Nowhere,
    On(&'a Output),
    /// A share we can't place, and the reason the tab is told.
    Unplaced(&'static str),
}

impl App {
    pub fn new(wanted: Option<String>) -> Self {
        Self { wanted, ..Self::default() }
    }

    /// Returns true when what's on screen may have changed.
    pub fn handle(&mut self, event: Event, now: f64) -> bool {
        match event {
            Event::Connected(id) => {
                self.conn = Some(id);
                self.reset();
            }
            Event::Disconnected(id) if self.conn == Some(id) => {
                self.conn = None;
                self.reset();
            }
            Event::Disconnected(_) => return false,
            Event::Message(id, _) if self.conn != Some(id) => return false,
            Event::Message(_, msg) => match msg {
                Inbound::Share { generation, me, w, h } => {
                    self.board.clear();
                    self.share = Some(Share { generation, me, width: w, height: h });
                }
                Inbound::Stop { generation } => {
                    if self.share.as_ref().is_none_or(|s| s.generation != generation) {
                        return false;
                    }
                    self.reset();
                }
                Inbound::Mark { generation, author, name, color, mark } => {
                    if self.share.as_ref().is_none_or(|s| s.generation != generation) {
                        return false;
                    }
                    return self.board.apply(&author, &name, color, mark, now);
                }
                Inbound::Forget { author } => self.board.forget(&author),
            },
        }
        true
    }

    fn reset(&mut self) {
        self.share = None;
        self.board.clear();
    }

    pub fn target<'a>(&self, outputs: &'a [Output]) -> Target<'a> {
        let Some(share) = &self.share else { return Target::Nowhere };
        match monitor::pick(outputs, share.width, share.height, self.wanted.as_deref()) {
            Pick::Output(o) => Target::On(o),
            Pick::NoMatch => Target::Unplaced("no-match"),
            Pick::Ambiguous => Target::Unplaced("ambiguous"),
        }
    }

    /// The status to send now for the current share, if it hasn't gone out yet. `drawing_on` is the
    /// output whose overlay is mapped (configured), if any.
    pub fn status(&mut self, outputs: &[Output], drawing_on: Option<&str>) -> Option<(u64, String)> {
        let (conn, share) = (self.conn?, self.share.as_ref()?);
        let text = match self.target(outputs) {
            Target::On(o) if drawing_on == Some(o.name.as_str()) => protocol::status(share.generation, Ok(&o.name)),
            // Not mapped yet: say nothing until it is.
            Target::On(_) | Target::Nowhere => return None,
            Target::Unplaced(why) => {
                let sizes: Vec<String> =
                    outputs.iter().map(|o| format!("{} {}x{}", o.name, o.width, o.height)).collect();
                protocol::status(share.generation, Err((why, &sizes)))
            }
        };
        let key = (conn, share.generation, text);
        if self.sent.as_ref() == Some(&key) {
            return None;
        }
        self.sent = Some(key.clone());
        Some((conn, key.2))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::Mark;

    const ME: &str = "sharer01";
    const YOU: &str = "viewer01";

    fn outputs() -> Vec<Output> {
        vec![
            Output { name: "DP-2".into(), width: 3440, height: 1440 },
            Output { name: "DP-3".into(), width: 1440, height: 2560 },
        ]
    }

    fn msg(id: u64, m: Inbound) -> Event {
        Event::Message(id, m)
    }

    fn share(generation: u32) -> Inbound {
        Inbound::Share { generation, me: ME.into(), w: 2560, h: 1072 }
    }

    fn mark(generation: u32, x: f32) -> Inbound {
        Inbound::Mark {
            generation,
            author: YOU.into(),
            name: "You".into(),
            color: [1, 2, 3],
            mark: Mark::Move { x, y: 0.5 },
        }
    }

    fn pointer(app: &App) -> Option<(f32, f32)> {
        app.board.visible(0.0, None).first().and_then(|m| m.pointer)
    }

    #[test]
    fn marks_count_only_for_the_current_share_of_the_current_tab() {
        let mut app = App::new(None);
        app.handle(Event::Connected(1), 0.0);
        assert!(!app.handle(msg(1, mark(1, 0.1)), 0.0), "no share yet");
        app.handle(msg(1, share(1)), 0.0);
        assert!(app.handle(msg(1, mark(1, 0.2)), 0.0));
        assert!(!app.handle(msg(1, mark(0, 0.3)), 0.0), "stale gen");
        assert!(!app.handle(msg(2, mark(1, 0.4)), 0.0), "another connection");
        assert_eq!(pointer(&app), Some((0.2, 0.5)));
        // A new share starts clean.
        app.handle(msg(1, share(2)), 0.0);
        assert!(app.board.is_empty());
        // Stopping an old share changes nothing; stopping this one clears.
        assert!(!app.handle(msg(1, Inbound::Stop { generation: 1 }), 0.0));
        app.handle(msg(1, mark(2, 0.5)), 0.0);
        app.handle(msg(1, Inbound::Stop { generation: 2 }), 0.0);
        assert!(app.board.is_empty() && app.share.is_none());
    }

    #[test]
    fn a_closed_or_replaced_tab_clears_everything() {
        let mut app = App::new(None);
        app.handle(Event::Connected(1), 0.0);
        app.handle(msg(1, share(1)), 0.0);
        app.handle(msg(1, mark(1, 0.2)), 0.0);
        // The newest tab takes over; the old one's close arrives late and changes nothing.
        app.handle(Event::Connected(2), 0.0);
        assert!(app.board.is_empty() && app.share.is_none());
        app.handle(msg(2, share(5)), 0.0);
        assert!(!app.handle(Event::Disconnected(1), 0.0));
        assert!(app.share.is_some());
        app.handle(Event::Disconnected(2), 0.0);
        assert!(app.share.is_none());
    }

    #[test]
    fn status_waits_for_the_overlay_and_goes_out_once() {
        let mut app = App::new(None);
        let outs = outputs();
        app.handle(Event::Connected(1), 0.0);
        app.handle(msg(1, share(1)), 0.0);
        assert_eq!(app.target(&outs), Target::On(&outs[0]));
        assert_eq!(app.status(&outs, None), None);
        let (conn, text) = app.status(&outs, Some("DP-2")).unwrap();
        assert_eq!((conn, text.as_str()), (1, r#"{"gen":1,"output":"DP-2","t":"status"}"#));
        assert_eq!(app.status(&outs, Some("DP-2")), None);
    }

    #[test]
    fn an_unplaceable_share_says_why_with_every_monitors_size() {
        let mut app = App::new(None);
        let outs = outputs();
        app.handle(Event::Connected(1), 0.0);
        app.handle(msg(1, Inbound::Share { generation: 1, me: ME.into(), w: 1920, h: 1080 }), 0.0);
        let (_, text) = app.status(&outs, None).unwrap();
        assert_eq!(
            text,
            r#"{"gen":1,"output":null,"outputs":["DP-2 3440x1440","DP-3 1440x2560"],"t":"status","why":"no-match"}"#
        );
        // --output naming a monitor of another shape doesn't override the check.
        let mut app = App::new(Some("DP-3".into()));
        app.handle(Event::Connected(1), 0.0);
        app.handle(msg(1, share(1)), 0.0);
        assert_eq!(app.target(&outs), Target::Unplaced("no-match"));
    }
}
