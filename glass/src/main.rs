//! Streamroom Glass: draws the pointers and pen strokes from a Streamroom call on the real desktop
//! of the person sharing their screen. Their Streamroom tab sends the marks over a loopback WebSocket.

mod app;
mod board;
mod monitor;
mod protocol;
mod render;
mod server;
#[cfg(target_os = "linux")]
mod wayland;

use std::net::{Ipv4Addr, TcpListener};
use std::process::ExitCode;

const USAGE: &str = "\
Usage: streamroom-glass --origin <url> [--origin <url>...] [--output <name>]

Draws everyone's pointers and pen strokes from a Streamroom call on the screen you share.
Turn on \"Show marks on my desktop\" on your own share in Streamroom, then run this.

  --origin <url>   The Streamroom address you use, exactly as in the address bar, without a path,
                   for example https://streamroom.example.com. Only pages there may connect.
  --output <name>  The monitor you share, when two of them have the same shape (e.g. DP-1).
  -h, --help       Show this help.
  -V, --version    Show the version.";

fn main() -> ExitCode {
    let mut origins = Vec::new();
    let mut output = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--origin" => match args.next().as_deref().map(normalize_origin) {
                Some(Ok(origin)) => origins.push(origin),
                Some(Err(e)) => return fail(&e),
                None => return fail("--origin needs a URL"),
            },
            "--output" => match args.next() {
                Some(name) => output = Some(name),
                None => return fail("--output needs a monitor name"),
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "-V" | "--version" => {
                println!("streamroom-glass {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            other => return fail(&format!("unknown argument {other:?}")),
        }
    }
    if origins.is_empty() {
        return fail("give the Streamroom address with --origin");
    }
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, server::PORT)) {
        Ok(l) => l,
        Err(e) => {
            return fail(&format!(
                "can't listen on 127.0.0.1:{}: {e} (is Streamroom Glass already running?)",
                server::PORT
            ));
        }
    };
    eprintln!("Streamroom Glass is listening on 127.0.0.1:{} for {}", server::PORT, origins.join(", "));
    match run(listener, origins, output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fail(&e),
    }
}

#[cfg(target_os = "linux")]
fn run(listener: TcpListener, origins: Vec<String>, output: Option<String>) -> Result<(), String> {
    wayland::run(listener, origins, output)
}

#[cfg(not(target_os = "linux"))]
fn run(_: TcpListener, _: Vec<String>, _: Option<String>) -> Result<(), String> {
    Err("this build has no overlay for this system yet".into())
}

fn fail(message: &str) -> ExitCode {
    eprintln!("streamroom-glass: {message}\n\n{USAGE}");
    ExitCode::FAILURE
}

/// Browsers send `Origin` as scheme://host[:port], lowercase, no trailing slash.
fn normalize_origin(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_ascii_lowercase();
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    match rest {
        Some(host) if !host.is_empty() && !host.contains(['/', '?', '#', '@', ' ']) => Ok(url),
        _ => Err(format!("{url:?} isn't an origin like https://streamroom.example.com")),
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_origin;

    #[test]
    fn origins_are_written_the_way_browsers_send_them() {
        assert_eq!(normalize_origin("https://Streamroom.Example.com/").unwrap(), "https://streamroom.example.com");
        assert_eq!(normalize_origin("http://localhost:5173").unwrap(), "http://localhost:5173");
        assert!(normalize_origin("https://streamroom.example.com/r/abc").is_err());
        assert!(normalize_origin("streamroom.example.com").is_err());
        assert!(normalize_origin("https://").is_err());
    }
}
