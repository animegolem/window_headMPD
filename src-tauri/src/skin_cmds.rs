//! Skin archive glue (ENGINE.md D4): the commands over `headcore::skinstore::SkinStore`.
//!
//! Importing hashes up to 32 MiB and reading re-hashes it, so those commands run on the blocking
//! pool instead of the main thread, where synchronous commands run.

use headcore::skinstore::{SkinRecord, SkinStore};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

/// The env var that points the app at a skin archive (D4; the webview cannot read process env).
const SKIN_ENV: &str = "WINDOW_HEADMPD_SKIN";
/// The owner's phase-1 fixture (E §1 rule 7), relative to the home directory.
const DEFAULT_SKIN: &str = "Downloads/Headspace.wmz";

pub struct Skins(Arc<SkinStore>);

impl Skins {
    pub fn new(app_data_dir: &Path) -> Self {
        Skins(Arc::new(SkinStore::new(app_data_dir)))
    }
}

fn store(app: &AppHandle) -> Result<Arc<SkinStore>, String> {
    app.try_state::<Skins>()
        .map(|s| s.0.clone())
        .ok_or_else(|| "the skin store is unavailable (no app data directory)".into())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Called only by AppShell code (first-run import, the env var). The path guard is the store's.
#[tauri::command]
pub async fn skin_import(app: AppHandle, path: String) -> Result<SkinRecord, String> {
    let store = store(&app)?;
    blocking(move || store.import(Path::new(&path)).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn skin_list(app: AppHandle) -> Vec<SkinRecord> {
    let Ok(store) = store(&app) else {
        return Vec::new();
    };
    blocking(move || Ok(store.list())).await.unwrap_or_default()
}

/// The archive's bytes as a raw response, never a JSON number array.
#[tauri::command]
pub async fn skin_read(app: AppHandle, sha: String) -> Result<Response, String> {
    let store = store(&app)?;
    let bytes = blocking(move || store.read(&sha).map_err(|e| e.to_string())).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn skin_remove(app: AppHandle, sha: String) -> Result<(), String> {
    let store = store(&app)?;
    blocking(move || store.remove(&sha).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub fn skin_default_path() -> Option<String> {
    default_path(
        std::env::var_os(SKIN_ENV),
        std::env::var_os("HOME").map(PathBuf::from),
        |p| p.is_file(),
    )
}

/// `WINDOW_HEADMPD_SKIN` when set (validated later by `skin_import`, not here), else
/// `~/Downloads/Headspace.wmz` when that file exists, else nothing. An empty variable counts as
/// unset, and a path that is not valid UTF-8 cannot cross IPC, so it counts as unset too.
fn default_path(
    env: Option<OsString>,
    home: Option<PathBuf>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<String> {
    if let Some(v) = env
        .filter(|v| !v.is_empty())
        .and_then(|v| v.into_string().ok())
    {
        return Some(v);
    }
    let candidate = home?.join(DEFAULT_SKIN);
    if is_file(&candidate) {
        candidate.into_os_string().into_string().ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/someone";

    fn home() -> Option<PathBuf> {
        Some(PathBuf::from(HOME))
    }

    #[test]
    fn the_env_var_wins_without_an_existence_check() {
        let got = default_path(Some("/tmp/x.wmz".into()), home(), |_| {
            panic!("the env path is not probed")
        });
        assert_eq!(got.as_deref(), Some("/tmp/x.wmz"));
    }

    #[test]
    fn falls_back_to_the_downloads_fixture_when_it_exists() {
        let want = format!("{HOME}/Downloads/Headspace.wmz");
        let got = default_path(None, home(), |p| p == Path::new(&want));
        assert_eq!(got, Some(want.clone()));
        // An empty variable is unset.
        let got = default_path(Some(OsString::new()), home(), |p| p == Path::new(&want));
        assert_eq!(got, Some(want));
    }

    #[test]
    fn nothing_when_the_fixture_is_absent_or_there_is_no_home() {
        assert_eq!(default_path(None, home(), |_| false), None);
        assert_eq!(default_path(None, None, |_| true), None);
    }

    #[test]
    fn a_non_utf8_env_value_counts_as_unset() {
        use std::os::unix::ffi::OsStringExt;
        let bad = OsString::from_vec(vec![b'/', 0xff, b'.', b'w', b'm', b'z']);
        assert_eq!(default_path(Some(bad), home(), |_| false), None);
    }
}
