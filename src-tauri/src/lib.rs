mod audio;
mod eq;
mod hit_cmds;
mod mpd;
mod outputs;
mod prefs_cmds;
mod skin_cmds;

use audio::{Engine, Frame, Mode};
use headcore::guards::{mpd_verb_allowed, record_path_allowed};
use hit_cmds::Hit;
use prefs_cmds::Prefs;
use serde::{Deserialize, Serialize};
use skin_cmds::Skins;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};

struct App {
    cmd: Mutex<Option<mpd::Conn>>,
    engine: Arc<Engine>,
    takeover: Mutex<Option<outputs::Takeover>>,
    /// Why the Headspace output isn't in use, if it isn't.
    route_error: Mutex<Option<String>>,
}

// ---- MPD -------------------------------------------------------------------

/// Whether the page may send this MPD command (E §7). The verb must be on the allow-list, and no
/// argument may hold a line break or NUL: `mpd.rs` quotes arguments but MPD reads line by line,
/// so `load "x\nkill"` would otherwise smuggle a second, unlisted command past the verb check.
fn check_mpd_args(args: &[String]) -> Result<(), String> {
    let Some(verb) = args.first() else {
        return Err("empty MPD command".into());
    };
    if !mpd_verb_allowed(verb) {
        return Err(format!("MPD command not allowed: {verb:?}"));
    }
    args[1..].iter().try_for_each(|a| check_line_safe(a))
}

/// One protocol line: no CR, LF or NUL inside an argument.
fn check_line_safe(arg: &str) -> Result<(), String> {
    if arg.contains(['\n', '\r', '\0']) {
        Err("MPD argument contains a line break or NUL".into())
    } else {
        Ok(())
    }
}

/// Run one MPD command on the shared command connection, reconnecting once
/// if the server dropped us (MPD closes idle clients after a minute).
#[tauri::command]
fn mpd(app: State<'_, App>, args: Vec<String>) -> Result<mpd::Pairs, String> {
    check_mpd_args(&args)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut slot = app.cmd.lock().unwrap();
    for attempt in 0..2 {
        if slot.is_none() {
            let c = mpd::Conn::connect().map_err(|e| format!("MPD unreachable: {e}"))?;
            c.set_read_timeout(Some(Duration::from_secs(5))).ok();
            *slot = Some(c);
        }
        match slot.as_mut().unwrap().command(&args) {
            Ok(r) => return r,
            Err(e) => {
                *slot = None;
                if attempt == 1 {
                    return Err(e.to_string());
                }
            }
        }
    }
    unreachable!()
}

/// Watch MPD's `idle` stream and forward change notices to the page. Also
/// routes MPD into the app the first time we reach it.
fn idle_loop(handle: AppHandle) {
    let mut routed = false;
    loop {
        let Ok(mut conn) = mpd::Conn::connect() else {
            let _ = handle.emit("mpd-connection", false);
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        if !routed {
            route(&handle, &mut conn);
            routed = true;
        }
        let _ = handle.emit("mpd-connection", true);
        // A remote control channel: `mpc sendmessage window_head demo`.
        let _ = conn.command(&["subscribe", "window_head"]);
        loop {
            match conn.command(&["idle"]) {
                Ok(Ok(pairs)) => {
                    let changed: Vec<String> = pairs
                        .into_iter()
                        .filter(|(k, _)| k == "changed")
                        .map(|(_, v)| v)
                        .collect();
                    if changed.iter().any(|c| c == "message") {
                        if let Ok(Ok(msgs)) = conn.command(&["readmessages"]) {
                            for (_, text) in msgs.into_iter().filter(|(k, _)| k == "message") {
                                let _ = handle.emit("mpd-message", text);
                            }
                        }
                    }
                    let _ = handle.emit("mpd-idle", changed);
                }
                Ok(Err(_)) => continue,
                Err(_) => break,
            }
        }
        let _ = handle.emit("mpd-connection", false);
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn route(handle: &AppHandle, conn: &mut mpd::Conn) {
    let app = handle.state::<App>();
    outputs::recover(conn);
    if !outputs::has_ours(conn) {
        *app.route_error.lock().unwrap() = Some(format!(
            "Add the \"{}\" FIFO output to mpd.conf (see README)",
            outputs::OUR_OUTPUT
        ));
        return;
    }
    let silence = app.engine.mode() == Mode::Output;
    match outputs::take(conn, silence) {
        Ok(t) => *app.takeover.lock().unwrap() = Some(t),
        Err(e) => *app.route_error.lock().unwrap() = Some(e),
    }
}

fn give_back(app: &App) {
    if let Some(t) = app.takeover.lock().unwrap().take() {
        if let Ok(mut conn) = mpd::Conn::connect() {
            outputs::give_back(&mut conn, &t);
        }
    }
}

// ---- audio -----------------------------------------------------------------

#[derive(Default, Deserialize)]
#[serde(default)]
struct SubscribeOpts {
    /// Phase 2 (E D11): frames carry no PCM yet; the wish is recorded.
    pcm: bool,
}

impl SubscribeOpts {
    /// The legacy call shape sends no `opts` at all.
    fn wants_pcm(opts: Option<SubscribeOpts>) -> bool {
        opts.is_some_and(|o| o.pcm)
    }
}

/// Both call shapes work: the legacy `{ onFrame }` (`viz/index.js`) and `{ onFrame, opts }`.
/// Returns the id `audio_unsubscribe` takes.
#[tauri::command]
fn audio_subscribe(
    window: WebviewWindow,
    app: State<'_, App>,
    on_frame: Channel<Frame>,
    opts: Option<SubscribeOpts>,
) -> u64 {
    let pcm = SubscribeOpts::wants_pcm(opts);
    app.engine.subscribe(window.label(), on_frame, pcm)
}

#[tauri::command]
fn audio_unsubscribe(app: State<'_, App>, id: u64) {
    app.engine.unsubscribe(id);
}

#[tauri::command]
fn set_eq(app: State<'_, App>, gains: [f32; 10]) {
    app.engine.eq.lock().unwrap().set_gains(gains);
}

#[tauri::command]
fn set_balance(app: State<'_, App>, balance: f32) {
    app.engine.eq.lock().unwrap().set_balance(balance);
}

#[tauri::command]
fn record_start(app: State<'_, App>) -> Result<(), String> {
    app.engine.record_start()
}

/// Writes the recording only under `/tmp`, `/private/tmp`, `$TMPDIR` or `~/Movies` (E §7). A
/// refused path still ends the recording, so its buffer stops growing.
#[tauri::command]
fn record_stop(app: State<'_, App>, path: String) -> Result<(), String> {
    let path = Path::new(&path);
    let tmpdir = std::env::var_os("TMPDIR").map(PathBuf::from);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if !record_path_allowed(path, tmpdir.as_deref(), home.as_deref()) {
        app.engine.record_cancel();
        return Err(format!(
            "record_stop: {} is not under /tmp, $TMPDIR or ~/Movies",
            path.display()
        ));
    }
    app.engine.record_stop(path)
}

#[derive(Serialize)]
struct EngineInfo {
    mode: Mode,
    routed: bool,
    error: Option<String>,
}

#[tauri::command]
fn engine_info(app: State<'_, App>) -> EngineInfo {
    EngineInfo {
        mode: app.engine.mode(),
        routed: app.takeover.lock().unwrap().is_some(),
        error: app.route_error.lock().unwrap().clone(),
    }
}

// ---- album-art palette -----------------------------------------------------

#[derive(Serialize)]
struct Swatch {
    hex: String,
    share: f64,
    oklch: [f32; 3],
}

/// OKLab k-means over the song's cover art (the same engine and settings
/// RMPC-Auto-Theme uses), dominance-ordered.
#[tauri::command]
async fn palette(file: String) -> Result<Vec<Swatch>, String> {
    // `fetch_art` puts `file` on an MPD command line.
    check_line_safe(&file)?;
    tauri::async_runtime::spawn_blocking(move || {
        let art = mpd::fetch_art(&file)?;
        let req = color_core::AnalyzeRequest {
            path: String::new(),
            k: 8,
            stride: 4,
            quality: Some(2),
            ignore_top_n: 0,
            merge_threshold: 0.08,
            min_lum: 0,
            tol: 1e-3,
            max_iter: 40,
            seed: 1,
            max_samples: color_core::analyze::default_max_samples(),
            snap_to_real: false,
        };
        let res = color_core::analyze(&req, color_core::ImageSource::Bytes(&art))
            .map_err(|e| e.to_string())?;
        Ok(res
            .clusters
            .iter()
            .map(|c| Swatch {
                hex: format!("#{:02x}{:02x}{:02x}", c.rgb.r, c.rgb.g, c.rgb.b),
                share: c.share,
                oklch: c.oklch,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Page errors land in the terminal running `tauri dev`.
#[tauri::command]
fn js_log(msg: String) {
    eprintln!("[page] {msg}");
}

// ---- boot ------------------------------------------------------------------

/// A window that is gone, or a page that is starting over, keeps no click-through entry and no
/// frame subscribers: a reloaded page's old channel would otherwise be fed forever, since a send
/// to a live webview never fails.
fn forget_window<R: tauri::Runtime>(handle: &impl Manager<R>, label: &str) {
    handle.state::<Hit>().forget(label);
    handle.state::<App>().engine.drop_label(label);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (engine, stream) = audio::start();
    // The stream plays for the life of the process; cpal streams aren't Send,
    // so rather than park it in managed state we let it live forever.
    std::mem::forget(stream);

    let app = tauri::Builder::default()
        .manage(App {
            cmd: Mutex::new(None),
            engine,
            takeover: Mutex::new(None),
            route_error: Mutex::new(None),
        })
        .manage(Hit::default())
        .setup(|app| {
            // Legacy mode needs neither store, so a missing app data dir must not stop the boot;
            // their commands report it instead.
            match app.path().app_data_dir() {
                Ok(data) => {
                    app.manage(Skins::new(&data));
                    app.manage(Prefs::new(&data));
                }
                Err(e) => eprintln!("[app] no app data dir, skin and pref stores disabled: {e}"),
            }
            let h = app.handle().clone();
            std::thread::Builder::new()
                .name("mpd-idle".into())
                .spawn(move || idle_loop(h))?;
            hit_cmds::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                forget_window(window, window.label());
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                forget_window(webview, webview.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            mpd,
            audio_subscribe,
            audio_unsubscribe,
            set_eq,
            set_balance,
            engine_info,
            palette,
            hit_cmds::hit_set_bits,
            hit_cmds::hit_set_regions,
            hit_cmds::hit_capture,
            hit_cmds::set_hit_mask,
            hit_cmds::set_capture,
            skin_cmds::skin_import,
            skin_cmds::skin_list,
            skin_cmds::skin_read,
            skin_cmds::skin_remove,
            skin_cmds::skin_default_path,
            prefs_cmds::prefs_load,
            prefs_cmds::prefs_write,
            js_log,
            record_start,
            record_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building window_headMPD");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            give_back(&handle.state::<App>());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn every_command_the_pages_send_passes() {
        // player.js, playlist.js, demo.js and hosts/tauri/media.js, as they call `mpd(...)`.
        for a in [
            &["status"][..],
            &["currentsong"],
            &["playlistinfo"],
            &["listplaylists"],
            &["listplaylistinfo", "Road Trip"],
            &["play"],
            &["play", "3"],
            &["pause", "1"],
            &["pause", "0"],
            &["stop"],
            &["next"],
            &["previous"],
            &["seekcur", "12.50"],
            &["setvol", "80"],
            &["clear"],
            &["load", "name with \"quotes\" and \\"],
        ] {
            assert_eq!(check_mpd_args(&args(a)), Ok(()), "{a:?}");
        }
    }

    #[test]
    fn unlisted_verbs_and_empty_commands_are_refused() {
        for a in [
            &[][..],
            &["kill"],
            &["rm", "x"],
            &["sendmessage", "window_head", "demo"],
            &["password", "x"],
            &["STATUS"],
            &["status "],
            &["play\nkill"],
        ] {
            assert!(check_mpd_args(&args(a)).is_err(), "{a:?}");
        }
    }

    #[test]
    fn a_line_break_in_an_argument_cannot_smuggle_a_second_command() {
        for bad in ["x\nkill", "x\rkill", "x\0", "\n"] {
            assert!(check_mpd_args(&args(&["load", bad])).is_err(), "{bad:?}");
            assert!(check_line_safe(bad).is_err(), "{bad:?}");
        }
        assert!(check_line_safe("Artist/Album/01 Track.flac").is_ok());
    }

    #[test]
    fn subscribe_opts_accept_both_call_shapes() {
        // `{ onFrame }` leaves `opts` absent (None); `{ onFrame, opts: {} }` and `{ pcm: true }`
        // both deserialize.
        let empty: SubscribeOpts = serde_json::from_str("{}").unwrap();
        assert!(!empty.pcm);
        let pcm: SubscribeOpts = serde_json::from_str(r#"{"pcm":true}"#).unwrap();
        assert!(pcm.pcm);
        assert!(!SubscribeOpts::wants_pcm(None));
        assert!(!SubscribeOpts::wants_pcm(Some(empty)));
        assert!(SubscribeOpts::wants_pcm(Some(pcm)));
    }
}
