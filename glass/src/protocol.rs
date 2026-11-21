//! Messages from the sharer's Streamroom tab (src/web/rtc/glass.ts), one JSON text frame each.
//! Anything malformed or oversized is a protocol error: the app drops the connection and clears.

use serde_json::Value;

use crate::board::Mark;

pub const APP: &str = "streamroom-glass";
pub const VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024;
const MAX_NAME_CHARS: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub enum Inbound {
    /// A monitor share started (or its size changed). `me` is the sharer's member id; `w`×`h` the
    /// captured picture, used to find which monitor it is.
    Share {
        generation: u32,
        me: String,
        w: u32,
        h: u32,
    },
    /// That share stopped.
    Stop {
        generation: u32,
    },
    Mark {
        generation: u32,
        author: String,
        name: String,
        color: [u8; 3],
        mark: Mark,
    },
    /// The member left the room.
    Forget {
        author: String,
    },
}

pub fn hello() -> String {
    format!(r#"{{"t":"hello","app":"{APP}","v":{VERSION}}}"#)
}

/// Where share `generation` is drawn: on `output`, or nowhere and why, with the monitors to pick from.
pub fn status(generation: u32, output: Result<&str, (&str, &[String])>) -> String {
    let v = match output {
        Ok(name) => serde_json::json!({ "t": "status", "gen": generation, "output": name }),
        Err((why, outputs)) => {
            serde_json::json!({ "t": "status", "gen": generation, "output": null, "why": why, "outputs": outputs })
        }
    };
    v.to_string()
}

pub fn parse(frame: &str) -> Option<Inbound> {
    if frame.len() > MAX_FRAME_BYTES {
        return None;
    }
    let v: Value = serde_json::from_str(frame).ok()?;
    let generation = || v.get("gen")?.as_u64().and_then(|g| u32::try_from(g).ok());
    match v.get("t")?.as_str()? {
        "share" => {
            let dim = |k| v.get(k)?.as_u64().filter(|&d| (1..=16_384).contains(&d)).map(|d| d as u32);
            Some(Inbound::Share { generation: generation()?, me: member(v.get("me")?)?, w: dim("w")?, h: dim("h")? })
        }
        "stop" => Some(Inbound::Stop { generation: generation()? }),
        "mark" => Some(Inbound::Mark {
            generation: generation()?,
            author: member(v.get("a")?)?,
            name: v.get("name")?.as_str()?.chars().take(MAX_NAME_CHARS).collect(),
            color: color(v.get("color")?.as_str()?)?,
            mark: mark(v.get("m")?)?,
        }),
        "forget" => Some(Inbound::Forget { author: member(v.get("a")?)? }),
        _ => None,
    }
}

/// Same rule as `isMemberId` in src/shared/protocol.ts.
fn member(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let ok = (8..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| s.to_owned())
}

fn color(s: &str) -> Option<[u8; 3]> {
    let hex = s.strip_prefix('#').filter(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some([byte(0)?, byte(2)?, byte(4)?])
}

fn mark(v: &Value) -> Option<Mark> {
    let at = || {
        let c = |k| v.get(k)?.as_f64().filter(|n| n.is_finite()).map(|n| n.clamp(0.0, 1.0) as f32);
        Some((c("x")?, c("y")?))
    };
    Some(match v.get("t")?.as_str()? {
        "move" => at().map(|(x, y)| Mark::Move { x, y })?,
        "down" => at().map(|(x, y)| Mark::Down { x, y })?,
        "line" => at().map(|(x, y)| Mark::Line { x, y })?,
        "up" => Mark::Up,
        "leave" => Mark::Leave,
        "clear" => Mark::Clear,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abcDEF12_-";

    #[test]
    fn parses_each_message() {
        assert_eq!(
            parse(&format!(r#"{{"t":"share","gen":3,"me":"{ID}","w":2560,"h":1072}}"#)),
            Some(Inbound::Share { generation: 3, me: ID.into(), w: 2560, h: 1072 })
        );
        assert_eq!(parse(r#"{"t":"stop","gen":3}"#), Some(Inbound::Stop { generation: 3 }));
        assert_eq!(
            parse(&format!(
                r##"{{"t":"mark","gen":3,"a":"{ID}","name":"Aden","color":"#f4b860","m":{{"t":"line","x":0.25,"y":1.5}}}}"##
            )),
            Some(Inbound::Mark {
                generation: 3,
                author: ID.into(),
                name: "Aden".into(),
                color: [0xf4, 0xb8, 0x60],
                mark: Mark::Line { x: 0.25, y: 1.0 }
            })
        );
        assert_eq!(parse(&format!(r#"{{"t":"forget","a":"{ID}"}}"#)), Some(Inbound::Forget { author: ID.into() }));
    }

    #[test]
    fn rejects_bad_input() {
        for bad in [
            "",
            "not json",
            r#"{"t":"share","gen":1,"me":"short","w":10,"h":10}"#,
            r#"{"t":"share","gen":1,"me":"abcDEF12","w":0,"h":10}"#,
            r#"{"t":"stop","gen":-1}"#,
            r##"{"t":"mark","gen":1,"a":"abcDEF12","name":"x","color":"red","m":{"t":"up"}}"##,
            r##"{"t":"mark","gen":1,"a":"abcDEF12","name":"x","color":"#ffffff","m":{"t":"line","x":null,"y":0}}"##,
            r##"{"t":"mark","gen":1,"a":"abc DEF12","name":"x","color":"#ffffff","m":{"t":"up"}}"##,
            r#"{"t":"bogus"}"#,
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        let long = format!(r#"{{"t":"forget","a":"{ID}","pad":"{}"}}"#, "x".repeat(MAX_FRAME_BYTES));
        assert_eq!(parse(&long), None);
    }

    #[test]
    fn the_longest_name_fits_in_a_frame() {
        // 32 four-byte code points, each escaped by JSON.stringify as a surrogate pair (12 bytes).
        let name = "\\ud83d\\ude00".repeat(32);
        let frame = format!(
            r##"{{"t":"mark","gen":4294967295,"a":"{}","name":"{name}","color":"#ffffff","m":{{"t":"line","x":0.1234,"y":0.5678}}}}"##,
            "x".repeat(32)
        );
        assert!(frame.len() <= MAX_FRAME_BYTES, "{}", frame.len());
        assert!(matches!(parse(&frame), Some(Inbound::Mark { .. })));
    }

    #[test]
    fn status_says_where_or_why_not() {
        assert_eq!(status(2, Ok("DP-2")), r#"{"gen":2,"output":"DP-2","t":"status"}"#);
        let outputs = ["DP-2".to_owned(), "DP-3".to_owned()];
        assert_eq!(
            status(2, Err(("ambiguous", &outputs))),
            r#"{"gen":2,"output":null,"outputs":["DP-2","DP-3"],"t":"status","why":"ambiguous"}"#
        );
    }

    #[test]
    fn long_names_are_cut_to_32_characters() {
        let name = "é".repeat(40);
        let Some(Inbound::Mark { name, .. }) = parse(&format!(
            r##"{{"t":"mark","gen":1,"a":"{ID}","name":"{name}","color":"#ffffff","m":{{"t":"up"}}}}"##
        )) else {
            panic!()
        };
        assert_eq!(name.chars().count(), 32);
    }
}
