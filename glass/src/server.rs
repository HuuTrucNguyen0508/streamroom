//! The WebSocket the sharer's Streamroom tab connects to: loopback only, allowed origins only, and one
//! tab at a time (the newest; the one it replaces is told so and stops retrying).

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message, WebSocket};

use crate::protocol::{self, Inbound, MAX_FRAME_BYTES};

pub const PORT: u16 = 47291;
/// Close code for a tab whose place another Streamroom tab took.
pub const REPLACED: u16 = 4001;

#[derive(Debug, PartialEq)]
pub enum Event {
    Connected(u64),
    Message(u64, Inbound),
    /// Closed, replaced, or sent something malformed: everything it drew goes.
    Disconnected(u64),
}

enum Out {
    Text(String),
    Replaced,
}

struct Current {
    id: u64,
    out: Sender<Out>,
}

/// Sends to the connected tab, if it is still the one `id` names.
#[derive(Clone)]
pub struct Outbox(Arc<Mutex<Option<Current>>>);

impl Outbox {
    pub fn send(&self, id: u64, text: String) {
        if let Some(c) = self.0.lock().unwrap().as_ref().filter(|c| c.id == id) {
            let _ = c.out.send(Out::Text(text));
        }
    }
}

pub struct Config {
    pub origins: Vec<String>,
}

/// Starts listening. Events arrive on `emit` from other threads.
pub fn start(config: Config, listener: TcpListener, emit: impl Fn(Event) + Send + Clone + 'static) -> Outbox {
    let current: Arc<Mutex<Option<Current>>> = Arc::default();
    let outbox = Outbox(current.clone());
    let origins = Arc::new(config.origins);
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(PORT);
    thread::spawn(move || {
        let mut next_id = 0;
        for stream in listener.incoming().flatten() {
            next_id += 1;
            let (id, current, origins, emit) = (next_id, current.clone(), origins.clone(), emit.clone());
            thread::spawn(move || serve(id, stream, port, &origins, &current, &emit));
        }
    });
    outbox
}

fn serve(
    id: u64,
    stream: TcpStream,
    port: u16,
    origins: &[String],
    current: &Mutex<Option<Current>>,
    emit: &impl Fn(Event),
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    #[allow(clippy::result_large_err)] // tungstenite's callback type
    let check = |req: &Request, res: Response| -> Result<Response, ErrorResponse> {
        let header = |k| req.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("");
        let host_ok = [format!("127.0.0.1:{port}"), format!("localhost:{port}")].iter().any(|h| h == header("host"));
        let origin_ok = origins.iter().any(|o| o == header("origin"));
        if host_ok && origin_ok {
            Ok(res)
        } else {
            eprintln!(
                "Refused a connection from origin {:?} (host {:?}). Allowed: {origins:?}",
                header("origin"),
                header("host")
            );
            let mut refusal = ErrorResponse::new(Some("Origin not allowed".into()));
            *refusal.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            Err(refusal)
        }
    };
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES * 4))
        .max_frame_size(Some(MAX_FRAME_BYTES * 4));
    let Ok(mut ws) = tungstenite::accept_hdr_with_config(stream, check, Some(config)) else { return };
    // Short reads, so replies and replacement get through between messages.
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(50)));

    let (out, outgoing) = mpsc::channel();
    {
        // Under the lock, so Connected events arrive in the order tabs took over.
        let mut cur = current.lock().unwrap();
        if let Some(old) = cur.replace(Current { id, out }) {
            let _ = old.out.send(Out::Replaced);
        }
        emit(Event::Connected(id));
    }
    if ws.send(Message::text(protocol::hello())).is_ok() {
        run(id, &mut ws, &outgoing, emit);
    }
    {
        let mut cur = current.lock().unwrap();
        if cur.as_ref().is_some_and(|c| c.id == id) {
            *cur = None;
        }
    }
    emit(Event::Disconnected(id));
}

fn run(id: u64, ws: &mut WebSocket<TcpStream>, outgoing: &Receiver<Out>, emit: &impl Fn(Event)) {
    loop {
        for out in outgoing.try_iter() {
            match out {
                Out::Text(text) => {
                    if ws.send(Message::text(text)).is_err() {
                        return;
                    }
                }
                Out::Replaced => {
                    close(ws, REPLACED, "replaced by another Streamroom tab");
                    return;
                }
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => match protocol::parse(&text) {
                Some(msg) => emit(Event::Message(id, msg)),
                None => {
                    close(ws, 1008, "malformed message");
                    return;
                }
            },
            Ok(Message::Close(_)) => {
                // Sends the close reply tungstenite queued.
                let _ = ws.flush();
                return;
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return,
            Ok(Message::Binary(_)) => {
                close(ws, 1003, "text only");
                return;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => return,
        }
    }
}

fn close(ws: &mut WebSocket<TcpStream>, code: u16, reason: &str) {
    let _ = ws.close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_owned().into() }));
    // Let the close frame go out before the socket drops.
    for _ in 0..20 {
        match ws.read() {
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::client::IntoClientRequest;

    const ORIGIN: &str = "https://streamroom.example";

    fn server() -> (u16, Outbox, mpsc::Receiver<Event>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        let tx = Arc::new(Mutex::new(tx));
        let outbox = start(Config { origins: vec![ORIGIN.into()] }, listener, move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        (port, outbox, rx)
    }

    fn connect(
        port: u16,
        origin: &str,
        host: &str,
    ) -> Result<WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>, tungstenite::Error> {
        let mut req = format!("ws://127.0.0.1:{port}/").into_client_request().unwrap();
        req.headers_mut().insert("origin", origin.parse().unwrap());
        req.headers_mut().insert("host", host.parse().unwrap());
        tungstenite::connect(req).map(|(ws, _)| ws)
    }

    fn next(rx: &mpsc::Receiver<Event>) -> Event {
        rx.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    fn read_text(ws: &mut WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>>) -> String {
        match ws.read().unwrap() {
            Message::Text(t) => t.to_string(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn says_hello_forwards_messages_and_replies() {
        let (port, outbox, rx) = server();
        let mut ws = connect(port, ORIGIN, &format!("127.0.0.1:{port}")).unwrap();
        assert_eq!(read_text(&mut ws), protocol::hello());
        let Event::Connected(id) = next(&rx) else { panic!() };
        ws.send(Message::text(r#"{"t":"stop","gen":7}"#)).unwrap();
        assert_eq!(next(&rx), Event::Message(id, Inbound::Stop { generation: 7 }));
        outbox.send(id, "reply".into());
        assert_eq!(read_text(&mut ws), "reply");
        ws.close(None).unwrap();
        assert_eq!(next(&rx), Event::Disconnected(id));
    }

    #[test]
    fn refuses_other_origins_and_hosts() {
        let (port, _outbox, rx) = server();
        let host = format!("127.0.0.1:{port}");
        assert!(connect(port, "https://evil.example", &host).is_err());
        assert!(connect(port, "", &host).is_err());
        // DNS rebinding: an allowed-looking page reached through some other name.
        assert!(connect(port, ORIGIN, &format!("rebind.example:{port}")).is_err());
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        assert!(connect(port, ORIGIN, &format!("localhost:{port}")).is_ok());
    }

    #[test]
    fn a_malformed_message_drops_the_connection() {
        let (port, _outbox, rx) = server();
        let mut ws = connect(port, ORIGIN, &format!("127.0.0.1:{port}")).unwrap();
        read_text(&mut ws);
        let Event::Connected(id) = next(&rx) else { panic!() };
        ws.send(Message::text("{\"t\":\"nope\"}")).unwrap();
        assert_eq!(next(&rx), Event::Disconnected(id));
        let closed = loop {
            match ws.read() {
                Ok(Message::Close(frame)) => break frame.map(|f| u16::from(f.code)),
                Ok(_) => {}
                Err(_) => break None,
            }
        };
        assert_eq!(closed, Some(1008));
    }

    #[test]
    fn tabs_connecting_at_once_end_with_the_app_following_the_tab_that_stayed() {
        for _ in 0..8 {
            let (port, _outbox, rx) = server();
            let host = format!("127.0.0.1:{port}");
            let tabs: Vec<_> = (0..2)
                .map(|_| {
                    let host = host.clone();
                    thread::spawn(move || {
                        let mut ws = connect(port, ORIGIN, &host).unwrap();
                        read_text(&mut ws);
                        ws
                    })
                })
                .collect();
            let mut tabs: Vec<_> = tabs.into_iter().map(|t| t.join().unwrap()).collect();
            let mut last_connected = None;
            while let Ok(e) = rx.recv_timeout(Duration::from_millis(300)) {
                if let Event::Connected(id) = e {
                    last_connected = Some(id);
                }
            }
            // Exactly one tab was replaced; the app's tab is the other one, which still gets replies.
            let replaced: Vec<bool> = tabs
                .iter_mut()
                .map(|ws| {
                    #[allow(irrefutable_let_patterns)] // Only TLS builds have other variants.
                    if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_ref() {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
                    }
                    matches!(ws.read(), Ok(Message::Close(Some(f))) if u16::from(f.code) == REPLACED)
                })
                .collect();
            assert_eq!(replaced.iter().filter(|&&r| r).count(), 1);
            let id = last_connected.unwrap();
            _outbox.send(id, "you".into());
            let stayed = replaced.iter().position(|&r| !r).unwrap();
            assert_eq!(read_text(&mut tabs[stayed]), "you");
        }
    }

    #[test]
    fn the_newest_tab_wins_and_the_old_one_is_told() {
        let (port, outbox, rx) = server();
        let host = format!("127.0.0.1:{port}");
        let mut first = connect(port, ORIGIN, &host).unwrap();
        read_text(&mut first);
        let Event::Connected(a) = next(&rx) else { panic!() };
        let mut second = connect(port, ORIGIN, &host).unwrap();
        read_text(&mut second);
        let Event::Connected(b) = next(&rx) else { panic!() };
        let closed = loop {
            match first.read() {
                Ok(Message::Close(frame)) => break frame.map(|f| u16::from(f.code)),
                Ok(_) => {}
                Err(_) => break None,
            }
        };
        assert_eq!(closed, Some(REPLACED));
        assert_eq!(next(&rx), Event::Disconnected(a));
        // Replies for the old tab go nowhere; the new one still gets its own.
        outbox.send(a, "stale".into());
        outbox.send(b, "fresh".into());
        assert_eq!(read_text(&mut second), "fresh");
    }
}
