//! Which monitor the browser shared. The browser doesn't say, so match the picture's shape.

/// A monitor's desktop size in logical pixels, after rotation (a portrait monitor is taller than wide).
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub name: String,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, PartialEq)]
pub enum Pick<'a> {
    Output(&'a Output),
    /// No monitor has the picture's shape: a window or region was shared, or `--output` names the wrong one.
    NoMatch,
    /// Several monitors have the picture's shape; `--output` must say which.
    Ambiguous,
}

/// Captures are scaled down to fit the preset, so only the aspect ratio survives, give or take rounding.
const TOLERANCE: f64 = 0.015;

pub fn pick<'a>(outputs: &'a [Output], share_w: u32, share_h: u32, wanted: Option<&str>) -> Pick<'a> {
    let ratio = share_w as f64 / share_h as f64;
    let fits = |o: &&Output| {
        o.width > 0 && o.height > 0 && ((o.width as f64 / o.height as f64) - ratio).abs() / ratio <= TOLERANCE
    };
    let mut matches = outputs.iter().filter(|o| wanted.is_none_or(|w| o.name == w)).filter(fits);
    match (matches.next(), matches.next()) {
        (Some(o), None) => Pick::Output(o),
        (None, _) => Pick::NoMatch,
        (Some(_), Some(_)) => Pick::Ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(name: &str, width: i32, height: i32) -> Output {
        Output { name: name.into(), width, height }
    }

    #[test]
    fn matches_the_shape_after_downscaling_and_rotation() {
        // This machine: an ultrawide, and a 2560×1440 monitor turned portrait.
        let outputs = [out("DP-2", 3440, 1440), out("DP-3", 1440, 2560)];
        // A 3440×1440 capture capped to 2560 wide arrives as 2560×1072.
        assert_eq!(pick(&outputs, 2560, 1072, None), Pick::Output(&outputs[0]));
        // The portrait one, capped to 1440 tall.
        assert_eq!(pick(&outputs, 810, 1440, None), Pick::Output(&outputs[1]));
        // A 16:9 window matches neither.
        assert_eq!(pick(&outputs, 1920, 1080, None), Pick::NoMatch);
    }

    #[test]
    fn twin_monitors_need_a_name_and_the_name_must_fit() {
        let outputs = [out("HDMI-A-1", 1920, 1080), out("DP-1", 1920, 1080)];
        assert_eq!(pick(&outputs, 1280, 720, None), Pick::Ambiguous);
        assert_eq!(pick(&outputs, 1280, 720, Some("DP-1")), Pick::Output(&outputs[1]));
        assert_eq!(pick(&outputs, 1000, 1000, Some("DP-1")), Pick::NoMatch);
        assert_eq!(pick(&outputs, 1280, 720, Some("DP-9")), Pick::NoMatch);
    }
}
