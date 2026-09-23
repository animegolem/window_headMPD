//! Minimal MPD protocol client.
//!
//! The protocol is line-based: send a command, read `key: value` lines until
//! `OK` or `ACK [...] message`. Binary responses (`readpicture`, `albumart`)
//! announce `binary: N`, then N raw bytes and a newline. That's the whole
//! surface this app needs, so we speak it directly instead of pulling in a
//! client crate.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub type Pairs = Vec<(String, String)>;

/// `MPD_HOST` / `MPD_PORT` when set, the usual localhost:6600 otherwise.
pub fn address() -> String {
    let host = std::env::var("MPD_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("MPD_PORT").unwrap_or_else(|_| "6600".into());
    format!("{host}:{port}")
}

pub struct Conn {
    reader: BufReader<TcpStream>,
    writer: TcpStream,
}

impl Conn {
    pub fn connect() -> io::Result<Self> {
        let addr = address();
        let sock = addr
            .parse()
            .map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)))
            .unwrap_or_else(|_| TcpStream::connect(&addr))?;
        sock.set_nodelay(true)?;
        let writer = sock.try_clone()?;
        let mut reader = BufReader::new(sock);
        let mut greeting = String::new();
        reader.read_line(&mut greeting)?;
        if !greeting.starts_with("OK MPD") {
            return Err(io::Error::other(format!("not MPD: {greeting:?}")));
        }
        Ok(Self { reader, writer })
    }

    /// Bound how long a read may block. The idle connection clears this; the
    /// command connection keeps it so a wedged server can't hang the UI.
    pub fn set_read_timeout(&self, t: Option<Duration>) -> io::Result<()> {
        self.writer.set_read_timeout(t)
    }

    fn send(&mut self, args: &[&str]) -> io::Result<()> {
        let mut line = String::new();
        for (i, a) in args.iter().enumerate() {
            if i == 0 {
                line.push_str(a);
            } else {
                line.push(' ');
                line.push_str(&quote(a));
            }
        }
        line.push('\n');
        self.writer.write_all(line.as_bytes())
    }

    /// Run one command. Protocol errors (`ACK`) come back as `Ok(Err(msg))`
    /// so callers can tell "MPD said no" from "the socket died".
    pub fn command(&mut self, args: &[&str]) -> io::Result<Result<Pairs, String>> {
        self.send(args)?;
        let (pairs, _) = self.read_response(false)?;
        Ok(pairs)
    }

    /// Like [`command`], but collects a trailing binary payload.
    pub fn binary_command(
        &mut self,
        args: &[&str],
    ) -> io::Result<Result<(Pairs, Vec<u8>), String>> {
        self.send(args)?;
        let (pairs, bin) = self.read_response(true)?;
        Ok(pairs.map(|p| (p, bin)))
    }

    fn read_response(&mut self, binary: bool) -> io::Result<(Result<Pairs, String>, Vec<u8>)> {
        let mut pairs = Vec::new();
        let mut bin = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            if self.reader.read_line(&mut line)? == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            let l = line.trim_end_matches('\n');
            if l == "OK" {
                return Ok((Ok(pairs), bin));
            }
            if let Some(err) = l.strip_prefix("ACK ") {
                // "ACK [50@0] {cmd} message" -> "message"
                let msg = err.rsplit_once("} ").map(|(_, m)| m).unwrap_or(err);
                return Ok((Err(msg.to_string()), bin));
            }
            let Some((k, v)) = l.split_once(": ") else { continue };
            if binary && k == "binary" {
                let n: usize = v.parse().map_err(io::Error::other)?;
                let start = bin.len();
                bin.resize(start + n, 0);
                self.reader.read_exact(&mut bin[start..])?;
                let mut nl = [0u8; 1];
                self.reader.read_exact(&mut nl)?;
                continue;
            }
            pairs.push((k.to_string(), v.to_string()));
        }
    }
}

fn quote(arg: &str) -> String {
    let mut s = String::with_capacity(arg.len() + 2);
    s.push('"');
    for c in arg.chars() {
        if c == '"' || c == '\\' {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('"');
    s
}

pub fn get<'a>(pairs: &'a Pairs, key: &str) -> Option<&'a str> {
    pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// Fetch cover art for a song: embedded picture first, then the folder's
/// cover file. Uses its own connection so a large transfer never blocks
/// transport commands.
pub fn fetch_art(file: &str) -> Result<Vec<u8>, String> {
    let mut conn = Conn::connect().map_err(|e| e.to_string())?;
    conn.set_read_timeout(Some(Duration::from_secs(10))).ok();
    // Bigger chunks = far fewer round trips. Older servers just say no.
    let _ = conn.command(&["binarylimit", "1048576"]);
    for cmd in ["readpicture", "albumart"] {
        let mut data = Vec::new();
        loop {
            let offset = data.len().to_string();
            match conn.binary_command(&[cmd, file, &offset]).map_err(|e| e.to_string())? {
                Ok((pairs, chunk)) => {
                    let size: usize = get(&pairs, "size").and_then(|s| s.parse().ok()).unwrap_or(0);
                    if chunk.is_empty() {
                        break;
                    }
                    data.extend_from_slice(&chunk);
                    if data.len() >= size {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if !data.is_empty() {
            return Ok(data);
        }
    }
    Err("no album art".into())
}
