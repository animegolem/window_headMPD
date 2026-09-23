//! Taking over (and giving back) MPD's audio outputs.
//!
//! While the app runs in output mode, MPD plays into the Headspace FIFO and
//! its local-speaker outputs are switched off so you don't hear everything
//! twice. What we changed is written to disk *before* we change it, so a
//! crash is undone on the next launch; a clean quit undoes it immediately.

use crate::mpd::{Conn, Pairs};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const OUR_OUTPUT: &str = "Headspace";

/// Output plugins that make sound on this machine. Streaming and recording
/// outputs (httpd, snapcast, recorder, other FIFOs) are left alone.
const LOCAL_PLUGINS: &[&str] = &[
    "osx", "ao", "alsa", "pulse", "pipewire", "jack", "sndio", "oss", "openal", "wasapi", "winmm",
];

#[derive(Debug, Clone)]
pub struct Output {
    pub id: String,
    pub name: String,
    pub plugin: String,
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Takeover {
    /// Output names to switch back on at exit.
    pub reenable: Vec<String>,
    /// Output names to switch back off at exit.
    pub redisable: Vec<String>,
}

fn record_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join("Library/Application Support/com.animegolem.windowheadmpd/takeover.json")
}

pub fn list(conn: &mut Conn) -> Result<Vec<Output>, String> {
    let pairs: Pairs = conn
        .command(&["outputs"])
        .map_err(|e| e.to_string())??;
    let mut outs: Vec<Output> = Vec::new();
    for (k, v) in pairs {
        match k.as_str() {
            "outputid" => outs.push(Output {
                id: v,
                name: String::new(),
                plugin: String::new(),
                enabled: false,
            }),
            "outputname" => {
                if let Some(o) = outs.last_mut() {
                    o.name = v
                }
            }
            "plugin" => {
                if let Some(o) = outs.last_mut() {
                    o.plugin = v
                }
            }
            "outputenabled" => {
                if let Some(o) = outs.last_mut() {
                    o.enabled = v == "1"
                }
            }
            _ => {}
        }
    }
    Ok(outs)
}

fn set(conn: &mut Conn, outs: &[Output], name: &str, on: bool) {
    if let Some(o) = outs.iter().find(|o| o.name == name) {
        let cmd = if on { "enableoutput" } else { "disableoutput" };
        let _ = conn.command(&[cmd, &o.id]);
    }
}

/// Undo a takeover left behind by a crash.
pub fn recover(conn: &mut Conn) {
    let path = record_path();
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    if let Ok(t) = serde_json::from_str::<Takeover>(&text) {
        eprintln!("[outputs] restoring outputs from an unclean exit");
        apply_restore(conn, &t);
    }
    let _ = std::fs::remove_file(path);
}

fn apply_restore(conn: &mut Conn, t: &Takeover) {
    let Ok(outs) = list(conn) else { return };
    // Speakers back on before the FIFO goes off: no gap in the music.
    for n in &t.reenable {
        set(conn, &outs, n, true);
    }
    for n in &t.redisable {
        set(conn, &outs, n, false);
    }
}

/// Is the Headspace output configured at all?
pub fn has_ours(conn: &mut Conn) -> bool {
    list(conn).map(|o| o.iter().any(|o| o.name == OUR_OUTPUT)).unwrap_or(false)
}

/// Route MPD into the app. `silence_speakers` is false in monitor mode,
/// where we only need the FIFO for the visuals.
pub fn take(conn: &mut Conn, silence_speakers: bool) -> Result<Takeover, String> {
    let outs = list(conn)?;
    if !outs.iter().any(|o| o.name == OUR_OUTPUT) {
        return Err(format!("no \"{OUR_OUTPUT}\" output in mpd.conf"));
    }
    let mut t = Takeover::default();
    if let Some(o) = outs.iter().find(|o| o.name == OUR_OUTPUT && !o.enabled) {
        t.redisable.push(o.name.clone());
    }
    if silence_speakers {
        for o in &outs {
            if o.enabled && LOCAL_PLUGINS.contains(&o.plugin.as_str()) {
                t.reenable.push(o.name.clone());
            }
        }
    }

    let path = record_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, serde_json::to_string(&t).unwrap()).map_err(|e| e.to_string())?;

    set(conn, &outs, OUR_OUTPUT, true);
    for n in &t.reenable {
        set(conn, &outs, n, false);
    }
    Ok(t)
}

pub fn give_back(conn: &mut Conn, t: &Takeover) {
    apply_restore(conn, t);
    let _ = std::fs::remove_file(record_path());
}
