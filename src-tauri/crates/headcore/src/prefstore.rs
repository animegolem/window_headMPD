//! Preference store (ENGINE.md D6.4, Rust side).
//!
//! One JSON file per namespace, a flat object of strings:
//!
//! ```text
//! <app_data_dir>/prefs/<ns>.json      ns is 64 lowercase hex (a skin sha), `app` or `mediacenter`
//! ```
//!
//! Skins reach this only through a namespace the host picks (their own sha), so one skin cannot
//! name another's. The caps are enforced here a second time after the JS side, because the
//! webview is not a trust boundary. Writes go to a temp file that is renamed into place, and a
//! rejected write leaves the file exactly as it was.

use crate::skinstore::{atomic_write, is_valid_sha};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// Keys per namespace.
pub const MAX_KEYS: usize = 256;
/// Bytes (UTF-8) in one key.
pub const MAX_KEY_BYTES: usize = 256;
/// Bytes (UTF-8) in one value.
pub const MAX_VALUE_BYTES: usize = 4 * 1024;
/// Per namespace, the sum over every entry of its key bytes plus its value bytes. This is the
/// payload, not the JSON on disk, so the JS side can count the same thing with `TextEncoder`.
pub const MAX_NAMESPACE_BYTES: usize = 64 * 1024;

/// A namespace file this large cannot be one the caps allowed (JSON escaping at its worst turns
/// 64 KiB of payload into about 400 KiB), so a bigger one is not read.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
pub enum PrefError {
    BadNamespace,
    KeyTooLong,
    ValueTooLong,
    TooManyKeys,
    NamespaceFull,
    Io(io::Error),
}

impl fmt::Display for PrefError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PrefError::BadNamespace => {
                f.write_str("namespace must be 64 lowercase hex digits, `app` or `mediacenter`")
            }
            PrefError::KeyTooLong => write!(f, "preference key is over {MAX_KEY_BYTES} bytes"),
            PrefError::ValueTooLong => {
                write!(f, "preference value is over {MAX_VALUE_BYTES} bytes")
            }
            PrefError::TooManyKeys => write!(f, "namespace already holds {MAX_KEYS} keys"),
            PrefError::NamespaceFull => {
                write!(f, "namespace would exceed {MAX_NAMESPACE_BYTES} bytes")
            }
            PrefError::Io(e) => write!(f, "i/o error: {e}"),
        }
    }
}

impl std::error::Error for PrefError {}

impl From<io::Error> for PrefError {
    fn from(e: io::Error) -> Self {
        PrefError::Io(e)
    }
}

/// `^[0-9a-f]{64}$ | app | mediacenter`.
pub fn is_valid_namespace(ns: &str) -> bool {
    ns == "app" || ns == "mediacenter" || is_valid_sha(ns)
}

pub struct PrefStore {
    dir: PathBuf,
    /// Serialises every read-modify-write, so two writers cannot lose each other's key.
    lock: Mutex<()>,
}

impl PrefStore {
    /// `app_data_dir` is the Tauri app data directory; the store keeps its files in `prefs/`
    /// beneath it and creates that directory on the first write.
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        PrefStore {
            dir: app_data_dir.as_ref().join("prefs"),
            lock: Mutex::new(()),
        }
    }

    /// The namespace's keys, empty when it has never been written. A file that is not a flat
    /// object of strings, or that breaks a cap (so something other than this store wrote it),
    /// reads as empty and is replaced by the next write.
    pub fn load(&self, ns: &str) -> Result<HashMap<String, String>, PrefError> {
        if !is_valid_namespace(ns) {
            return Err(PrefError::BadNamespace);
        }
        self.read_map(ns)
    }

    /// Set `key` to `value`, or delete it when `value` is `None`. Over-cap writes return an
    /// error and change nothing; deleting an absent key or setting an unchanged value writes
    /// nothing. Overwriting a key at the 256-key limit is allowed, since it is not a new key.
    pub fn write(&self, ns: &str, key: &str, value: Option<&str>) -> Result<(), PrefError> {
        self.write_with(ns, key, value, &|| Ok(()))
    }

    /// `write` with a hook that runs after the temp file is written and before the rename; the
    /// tests fail it to prove the previous state survives.
    fn write_with(
        &self,
        ns: &str,
        key: &str,
        value: Option<&str>,
        before_rename: &dyn Fn() -> io::Result<()>,
    ) -> Result<(), PrefError> {
        if !is_valid_namespace(ns) {
            return Err(PrefError::BadNamespace);
        }
        if key.len() > MAX_KEY_BYTES {
            return Err(PrefError::KeyTooLong);
        }
        if value.is_some_and(|v| v.len() > MAX_VALUE_BYTES) {
            return Err(PrefError::ValueTooLong);
        }

        let _guard = self.guard();
        let mut map = self.read_map(ns)?;
        match value {
            Some(v) => {
                if map.get(key).is_some_and(|old| old == v) {
                    return Ok(());
                }
                map.insert(key.to_string(), v.to_string());
                check_caps(&map)?;
            }
            None => {
                if map.remove(key).is_none() {
                    return Ok(());
                }
            }
        }

        fs::create_dir_all(&self.dir)?;
        // A BTreeMap so the bytes on disk do not depend on hash order.
        let ordered: BTreeMap<&str, &str> =
            map.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let body = serde_json::to_vec(&ordered).map_err(io::Error::other)?;
        atomic_write(&self.dir, &self.path(ns), &body, before_rename)?;
        Ok(())
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Only ever called with a validated namespace, so the name cannot leave `prefs/`.
    fn path(&self, ns: &str) -> PathBuf {
        self.dir.join(format!("{ns}.json"))
    }

    fn read_map(&self, ns: &str) -> Result<HashMap<String, String>, PrefError> {
        let file = match File::open(self.path(ns)) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(e.into()),
        };
        let mut buf = Vec::new();
        file.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > MAX_FILE_BYTES {
            return Ok(HashMap::new());
        }
        match serde_json::from_slice::<HashMap<String, String>>(&buf) {
            Ok(map) if check_caps(&map).is_ok() => Ok(map),
            _ => Ok(HashMap::new()),
        }
    }
}

/// Every cap, over a whole namespace.
fn check_caps(map: &HashMap<String, String>) -> Result<(), PrefError> {
    if map.len() > MAX_KEYS {
        return Err(PrefError::TooManyKeys);
    }
    let mut total = 0usize;
    for (k, v) in map {
        if k.len() > MAX_KEY_BYTES {
            return Err(PrefError::KeyTooLong);
        }
        if v.len() > MAX_VALUE_BYTES {
            return Err(PrefError::ValueTooLong);
        }
        total += k.len() + v.len();
    }
    if total > MAX_NAMESPACE_BYTES {
        return Err(PrefError::NamespaceFull);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    const SHA: &str = "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85";

    fn setup() -> (TempDir, PrefStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = PrefStore::new(dir.path().join("appdata"));
        (dir, store)
    }

    fn dir_names(store: &PrefStore) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&store.dir)
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn expect(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn an_unwritten_namespace_loads_empty() {
        let (_dir, store) = setup();
        for ns in ["app", "mediacenter", SHA] {
            assert!(store.load(ns).unwrap().is_empty());
        }
        assert!(!store.dir.exists(), "loading creates nothing");
    }

    #[test]
    fn write_then_load_round_trips_set_overwrite_and_delete() {
        let (_dir, store) = setup();
        store.write(SHA, "a", Some("1")).unwrap();
        store.write(SHA, "b", Some("two")).unwrap();
        assert_eq!(
            store.load(SHA).unwrap(),
            expect(&[("a", "1"), ("b", "two")])
        );
        store.write(SHA, "a", Some("changed")).unwrap();
        store.write(SHA, "b", None).unwrap();
        assert_eq!(store.load(SHA).unwrap(), expect(&[("a", "changed")]));
        assert!(
            store.load("app").unwrap().is_empty(),
            "namespaces are separate"
        );
    }

    #[test]
    fn the_file_is_a_flat_json_object_named_for_the_namespace() {
        let (_dir, store) = setup();
        store.write("app", "zoom", Some("1.5")).unwrap();
        store.write("app", "alpha", Some("")).unwrap();
        let body = fs::read_to_string(store.dir.join("app.json")).unwrap();
        assert_eq!(body, r#"{"alpha":"","zoom":"1.5"}"#);
        assert_eq!(
            dir_names(&store),
            vec!["app.json".to_string()],
            "no temp file left"
        );
    }

    #[test]
    fn values_are_stored_verbatim_including_unicode_and_escapes() {
        let (_dir, store) = setup();
        let tricky = "caf\u{e9} \u{1f3b5} \"quoted\" back\\slash\nnewline\u{0}nul";
        store.write(SHA, "k\u{e9}y", Some(tricky)).unwrap();
        assert_eq!(
            store.load(SHA).unwrap().get("k\u{e9}y").map(String::as_str),
            Some(tricky)
        );
    }

    #[test]
    fn bad_namespaces_are_rejected_by_load_and_write_and_create_nothing() {
        let (dir, store) = setup();
        let sixty_five = "a".repeat(65);
        let sixty_three = "a".repeat(63);
        let upper = SHA.to_ascii_uppercase();
        let bad = [
            "",
            "App",
            "APP",
            "app ",
            " app",
            "mediacenter/x",
            "media center",
            "../app",
            "../../etc/passwd",
            "..",
            ".",
            "app\0",
            "app.json",
            "g739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85",
            sixty_three.as_str(),
            sixty_five.as_str(),
            upper.as_str(),
            "\u{ff41}pp",
        ];
        for ns in bad {
            assert!(
                matches!(store.load(ns).unwrap_err(), PrefError::BadNamespace),
                "load {ns:?}"
            );
            assert!(
                matches!(
                    store.write(ns, "k", Some("v")).unwrap_err(),
                    PrefError::BadNamespace
                ),
                "write {ns:?}"
            );
            assert!(
                matches!(
                    store.write(ns, "k", None).unwrap_err(),
                    PrefError::BadNamespace
                ),
                "delete {ns:?}"
            );
        }
        assert!(!store.dir.exists());
        assert!(!dir.path().join("etc").exists());
        for ns in ["app", "mediacenter", SHA] {
            assert!(is_valid_namespace(ns), "{ns}");
        }
    }

    #[test]
    fn the_257th_key_is_rejected_and_the_previous_state_is_kept() {
        let (_dir, store) = setup();
        for i in 0..MAX_KEYS {
            store.write(SHA, &format!("key{i}"), Some("v")).unwrap();
        }
        let before = fs::read(store.dir.join(format!("{SHA}.json"))).unwrap();
        let err = store.write(SHA, "one-too-many", Some("v")).unwrap_err();
        assert!(matches!(err, PrefError::TooManyKeys), "{err}");
        assert_eq!(
            fs::read(store.dir.join(format!("{SHA}.json"))).unwrap(),
            before
        );
        let loaded = store.load(SHA).unwrap();
        assert_eq!(loaded.len(), MAX_KEYS);
        assert!(!loaded.contains_key("one-too-many"));

        // At the limit, overwriting and deleting still work.
        store.write(SHA, "key0", Some("changed")).unwrap();
        store.write(SHA, "key1", None).unwrap();
        store.write(SHA, "one-too-many", Some("fits now")).unwrap();
        assert_eq!(store.load(SHA).unwrap().len(), MAX_KEYS);
    }

    #[test]
    fn a_4097_byte_value_is_rejected_and_4096_is_accepted() {
        let (_dir, store) = setup();
        store
            .write(SHA, "k", Some(&"x".repeat(MAX_VALUE_BYTES)))
            .unwrap();
        let err = store
            .write(SHA, "k", Some(&"y".repeat(MAX_VALUE_BYTES + 1)))
            .unwrap_err();
        assert!(matches!(err, PrefError::ValueTooLong), "{err}");
        assert_eq!(
            store.load(SHA).unwrap().get("k").map(String::len),
            Some(MAX_VALUE_BYTES)
        );

        // Bytes, not characters: 1,366 euro signs are 4,098 bytes.
        let euros = "\u{20ac}".repeat(1366);
        assert!(matches!(
            store.write(SHA, "e", Some(&euros)).unwrap_err(),
            PrefError::ValueTooLong
        ));
        assert!(!store.load(SHA).unwrap().contains_key("e"));
    }

    #[test]
    fn a_257_byte_key_is_rejected_and_256_is_accepted() {
        let (_dir, store) = setup();
        store
            .write(SHA, &"k".repeat(MAX_KEY_BYTES), Some("v"))
            .unwrap();
        let err = store
            .write(SHA, &"k".repeat(MAX_KEY_BYTES + 1), Some("v"))
            .unwrap_err();
        assert!(matches!(err, PrefError::KeyTooLong), "{err}");
        assert_eq!(store.load(SHA).unwrap().len(), 1);
        assert!(matches!(
            store
                .write(SHA, &"k".repeat(MAX_KEY_BYTES + 1), None)
                .unwrap_err(),
            PrefError::KeyTooLong
        ));
    }

    #[test]
    fn a_namespace_over_64_kib_is_rejected_and_exactly_64_kib_is_accepted() {
        let (_dir, store) = setup();
        // Fifteen one-byte keys with full 4,096-byte values: 15 * 4,097 = 61,455 bytes.
        for k in "abcdefghijklmno".chars() {
            store
                .write(SHA, &k.to_string(), Some(&"v".repeat(MAX_VALUE_BYTES)))
                .unwrap();
        }
        // 65,536 - 61,455 = 4,081 left: the key "p" plus a 4,080-byte value fills it exactly.
        store.write(SHA, "p", Some(&"v".repeat(4_080))).unwrap();
        let full = fs::read(store.dir.join(format!("{SHA}.json"))).unwrap();

        let err = store.write(SHA, "q", Some("")).unwrap_err();
        assert!(matches!(err, PrefError::NamespaceFull), "{err}");
        let err = store.write(SHA, "p", Some(&"v".repeat(4_081))).unwrap_err();
        assert!(matches!(err, PrefError::NamespaceFull), "{err}");
        assert_eq!(
            fs::read(store.dir.join(format!("{SHA}.json"))).unwrap(),
            full,
            "state kept"
        );
        let loaded = store.load(SHA).unwrap();
        assert_eq!(loaded.len(), 16);
        assert!(!loaded.contains_key("q"));

        // Freeing room makes the same write fit.
        store.write(SHA, "a", None).unwrap();
        store.write(SHA, "q", Some("")).unwrap();
        // Another namespace has its own budget.
        store.write("app", "p", Some(&"v".repeat(4_080))).unwrap();
    }

    #[test]
    fn a_failure_between_temp_write_and_rename_keeps_the_previous_state() {
        let (_dir, store) = setup();
        store.write(SHA, "a", Some("1")).unwrap();
        let before = fs::read(store.dir.join(format!("{SHA}.json"))).unwrap();

        let boom = || Err(io::Error::other("simulated failure"));
        let err = store.write_with(SHA, "a", Some("2"), &boom).unwrap_err();
        assert!(matches!(err, PrefError::Io(_)), "{err}");
        assert_eq!(
            fs::read(store.dir.join(format!("{SHA}.json"))).unwrap(),
            before
        );
        assert_eq!(store.load(SHA).unwrap(), expect(&[("a", "1")]));
        assert_eq!(
            dir_names(&store),
            vec![format!("{SHA}.json")],
            "no temp file left"
        );

        assert!(store.write_with(SHA, "a", None, &boom).is_err());
        assert_eq!(store.load(SHA).unwrap(), expect(&[("a", "1")]));
    }

    #[test]
    fn an_unchanged_value_or_an_absent_delete_writes_nothing() {
        let (_dir, store) = setup();
        store.write(SHA, "gone", None).unwrap();
        assert!(
            !store.dir.exists(),
            "deleting from an unwritten namespace creates nothing"
        );

        store.write(SHA, "a", Some("1")).unwrap();
        // Would fail if it reached the rename.
        let boom = || Err(io::Error::other("must not write"));
        store.write_with(SHA, "a", Some("1"), &boom).unwrap();
        store.write_with(SHA, "never-set", None, &boom).unwrap();
    }

    #[test]
    fn skin_chosen_keys_proto_and_constructor_are_ordinary_keys() {
        let (_dir, store) = setup();
        store.write(SHA, "__proto__", Some("p")).unwrap();
        store.write(SHA, "constructor", Some("c")).unwrap();
        store.write(SHA, "toString", Some("t")).unwrap();
        let loaded = store.load(SHA).unwrap();
        assert_eq!(
            loaded,
            expect(&[("__proto__", "p"), ("constructor", "c"), ("toString", "t")])
        );
        let on_disk: serde_json::Value =
            serde_json::from_slice(&fs::read(store.dir.join(format!("{SHA}.json"))).unwrap())
                .unwrap();
        assert_eq!(on_disk["__proto__"], "p");
        assert_eq!(on_disk.as_object().unwrap().len(), 3);
        store.write(SHA, "__proto__", None).unwrap();
        assert!(!store.load(SHA).unwrap().contains_key("__proto__"));
        assert!(store.load(SHA).unwrap().contains_key("constructor"));
    }

    #[test]
    fn a_corrupt_or_tampered_file_loads_empty_and_the_next_write_replaces_it() {
        let (_dir, store) = setup();
        store.write(SHA, "a", Some("1")).unwrap();
        let path = store.dir.join(format!("{SHA}.json"));

        let too_many: HashMap<String, String> = (0..=MAX_KEYS)
            .map(|i| (format!("k{i}"), "v".to_string()))
            .collect();
        let long_value = HashMap::from([("k".to_string(), "v".repeat(MAX_VALUE_BYTES + 1))]);
        let junk: Vec<Vec<u8>> = vec![
            b"not json".to_vec(),
            b"".to_vec(),
            b"[1,2]".to_vec(),
            br#"{"a":1}"#.to_vec(),
            br#"{"a":{"b":"c"}}"#.to_vec(),
            serde_json::to_vec(&too_many).unwrap(),
            serde_json::to_vec(&long_value).unwrap(),
            vec![b' '; MAX_FILE_BYTES as usize + 1],
        ];
        for body in junk {
            fs::write(&path, &body).unwrap();
            assert!(
                store.load(SHA).unwrap().is_empty(),
                "{}",
                String::from_utf8_lossy(&body[..body.len().min(40)])
            );
        }
        store.write(SHA, "b", Some("2")).unwrap();
        assert_eq!(store.load(SHA).unwrap(), expect(&[("b", "2")]));
    }

    #[test]
    fn concurrent_writers_do_not_lose_keys() {
        let (_dir, store) = setup();
        let store = Arc::new(store);
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let store = store.clone();
                std::thread::spawn(move || {
                    store
                        .write(SHA, &format!("k{i}"), Some(&i.to_string()))
                        .unwrap()
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let loaded = store.load(SHA).unwrap();
        assert_eq!(loaded.len(), 16);
        assert_eq!(loaded["k7"], "7");
    }
}
