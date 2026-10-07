//! Preference glue (ENGINE.md D6.4): the commands over `headcore::prefstore::PrefStore`, plus the
//! `prefs-changed` event that lets other windows follow a write.
//!
//! The JS side debounces writes (250 ms) and enforces the same caps first; the store enforces
//! them again here because the webview is not a trust boundary.

use headcore::prefstore::PrefStore;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub const PREFS_CHANGED: &str = "prefs-changed";

pub struct Prefs(Arc<PrefStore>);

impl Prefs {
    pub fn new(app_data_dir: &Path) -> Self {
        Prefs(Arc::new(PrefStore::new(app_data_dir)))
    }
}

/// The `prefs-changed` payload: `{ ns, key, value, window }`, `value` null for a delete. It goes to
/// every window, the writer included (a JS `listen` cannot be filtered by label from here), so a
/// listener skips events whose `window` is its own label.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PrefsChanged {
    pub ns: String,
    pub key: String,
    pub value: Option<String>,
    pub window: String,
}

fn store(app: &AppHandle) -> Result<Arc<PrefStore>, String> {
    app.try_state::<Prefs>()
        .map(|s| s.0.clone())
        .ok_or_else(|| "the pref store is unavailable (no app data directory)".into())
}

/// The namespace's keys, empty when never written. `ns` is 64 lowercase hex, `app` or
/// `mediacenter`; anything else is refused before the filesystem is touched.
#[tauri::command]
pub async fn prefs_load(app: AppHandle, ns: String) -> Result<HashMap<String, String>, String> {
    let store = store(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.load(&ns).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Sets `key` (or deletes it when `value` is null). An over-cap write is refused and changes
/// nothing. Every accepted write emits `prefs-changed`, including one that leaves the value as
/// it was.
#[tauri::command]
pub async fn prefs_write(
    app: AppHandle,
    window: WebviewWindow,
    ns: String,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let store = store(&app)?;
    let event = PrefsChanged {
        ns,
        key,
        value,
        window: window.label().to_owned(),
    };
    let write = event.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .write(&write.ns, &write.key, write.value.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    // The write landed; a failed broadcast must not report it as failed.
    let _ = app.emit(PREFS_CHANGED, event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_event_payload_has_the_documented_shape() {
        let set = PrefsChanged {
            ns: "app".into(),
            key: "zoom".into(),
            value: Some("1.5".into()),
            window: "main".into(),
        };
        assert_eq!(
            serde_json::to_value(&set).unwrap(),
            serde_json::json!({ "ns": "app", "key": "zoom", "value": "1.5", "window": "main" })
        );
        let delete = PrefsChanged { value: None, ..set };
        assert_eq!(
            serde_json::to_value(&delete).unwrap()["value"],
            serde_json::Value::Null
        );
    }
}
