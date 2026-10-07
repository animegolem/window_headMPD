//! Skin archive store (ENGINE.md D4, Rust side).
//!
//! Archives are stored whole under their SHA-256 and handed back as bytes; Rust never opens an
//! entry, so no filesystem path is ever derived from a name inside a skin. Layout under the app
//! data directory the store is built over:
//!
//! ```text
//! <app_data_dir>/skins/<sha>.<ext>    ext is wmz, wsz or zip, always lowercase
//! <app_data_dir>/skins/index.json     { "version": 1, "skins": [SkinRecord, ...] }
//! ```
//!
//! Every file is written to a temp file in the same directory and renamed into place, so a crash
//! or a failed write leaves the previous file whole.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// Largest archive `import` accepts and `read` returns (ENGINE.md section 10).
pub const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
/// The end-of-central-directory record is 22 bytes plus a comment of at most 65,535.
pub const EOCD_SEARCH_BYTES: usize = 65_557;

const EOCD_LEN: usize = 22;
const EOCD_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const EXTENSIONS: [&str; 3] = ["wmz", "wsz", "zip"];
const INDEX_FILE: &str = "index.json";
const INDEX_VERSION: u32 = 1;
const INDEX_MAX_BYTES: u64 = 4 * 1024 * 1024;
const NAME_MAX_BYTES: usize = 255;
const FAMILIES: [&str; 3] = ["wms", "wsz", "unknown"];

/// One imported archive, as the webview sees it.
///
/// `family` is a hint from the file extension alone (`.wmz` is `wms`, `.wsz` is `wsz`, `.zip` is
/// `unknown`) because Rust never looks inside the archive; the engine sniffs the real family.
/// `imported_at` is seconds since the Unix epoch. `name` is the source file's stem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkinRecord {
    pub sha: String,
    pub name: String,
    pub family: String,
    pub bytes: u64,
    pub imported_at: u64,
}

#[derive(Debug)]
pub enum SkinError {
    BadExtension,
    Symlink,
    NotRegularFile,
    TooLarge,
    NoEocd,
    BadSha,
    NotFound,
    /// The stored bytes no longer hash to the name they are stored under.
    Corrupt,
    Io(io::Error),
}

impl fmt::Display for SkinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SkinError::BadExtension => f.write_str("skin files must end in .wmz, .wsz or .zip"),
            SkinError::Symlink => f.write_str("symbolic links are not imported"),
            SkinError::NotRegularFile => f.write_str("not a regular file"),
            SkinError::TooLarge => f.write_str("skin archive is larger than 32 MiB"),
            SkinError::NoEocd => {
                f.write_str("not a zip archive (no end-of-central-directory record)")
            }
            SkinError::BadSha => f.write_str("skin id must be 64 lowercase hex digits"),
            SkinError::NotFound => f.write_str("no such skin"),
            SkinError::Corrupt => f.write_str("stored skin does not match its hash"),
            SkinError::Io(e) => write!(f, "i/o error: {e}"),
        }
    }
}

impl std::error::Error for SkinError {}

impl From<io::Error> for SkinError {
    fn from(e: io::Error) -> Self {
        SkinError::Io(e)
    }
}

/// `^[0-9a-f]{64}$`, checked byte-wise so nothing multi-byte or path-like can pass.
pub fn is_valid_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub struct SkinStore {
    dir: PathBuf,
    /// Serialises the read-modify-write of `index.json` across command threads.
    lock: Mutex<()>,
}

impl SkinStore {
    /// `app_data_dir` is the Tauri app data directory; the store keeps its files in `skins/`
    /// beneath it and creates that directory on the first import.
    pub fn new(app_data_dir: impl AsRef<Path>) -> Self {
        SkinStore {
            dir: app_data_dir.as_ref().join("skins"),
            lock: Mutex::new(()),
        }
    }

    /// Validate `path` (E D4: extension, regular file and not a symlink, at most 32 MiB, an
    /// end-of-central-directory signature in the last 65,557 bytes), then store the bytes as
    /// `<sha>.<ext>` and record them in the index. Importing the same bytes again keeps the first
    /// record and the stored file (rewriting the file only if it no longer holds those bytes),
    /// so one archive is one file and one entry, whatever its extension on the second import.
    pub fn import(&self, path: &Path) -> Result<SkinRecord, SkinError> {
        self.import_with(path, &|| Ok(()))
    }

    /// Every indexed skin whose archive is still on disk, in import order. A missing or
    /// unreadable index lists nothing; archives stay readable by sha either way.
    pub fn list(&self) -> Vec<SkinRecord> {
        self.read_index()
            .into_iter()
            .filter(|r| self.find_file(&r.sha).is_some())
            .collect()
    }

    /// The archive's bytes. The sha is validated before any filesystem access, and the bytes
    /// are hashed again so a file damaged on disk is reported instead of served.
    pub fn read(&self, sha: &str) -> Result<Vec<u8>, SkinError> {
        if !is_valid_sha(sha) {
            return Err(SkinError::BadSha);
        }
        let (path, _) = self.find_file(sha).ok_or(SkinError::NotFound)?;
        let file = File::open(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => SkinError::NotFound,
            _ => SkinError::Io(e),
        })?;
        let mut bytes = Vec::new();
        file.take(MAX_ARCHIVE_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES || sha256_hex(&bytes) != sha {
            return Err(SkinError::Corrupt);
        }
        Ok(bytes)
    }

    /// Delete the archive and its index entry. Removing a skin that is not there succeeds.
    pub fn remove(&self, sha: &str) -> Result<(), SkinError> {
        if !is_valid_sha(sha) {
            return Err(SkinError::BadSha);
        }
        let _guard = self.guard();
        // File first: a crash before the index update leaves an entry `list` skips, never an
        // orphan the index still advertises.
        for ext in EXTENSIONS {
            match fs::remove_file(self.dir.join(format!("{sha}.{ext}"))) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        let mut index = self.read_index();
        let before = index.len();
        index.retain(|r| r.sha != sha);
        if index.len() != before {
            self.write_index(&index, &|| Ok(()))?;
        }
        Ok(())
    }

    /// `import` with a hook that runs after each temp file is written and before it is renamed;
    /// the tests fail it to prove the previous file survives.
    fn import_with(
        &self,
        path: &Path,
        before_rename: &dyn Fn() -> io::Result<()>,
    ) -> Result<SkinRecord, SkinError> {
        let ext = allowed_extension(path).ok_or(SkinError::BadExtension)?;
        let bytes = read_candidate(path)?;
        if !has_eocd(&bytes) {
            return Err(SkinError::NoEocd);
        }
        let sha = sha256_hex(&bytes);

        let _guard = self.guard();
        fs::create_dir_all(&self.dir)?;
        let existing = self.find_file(&sha);
        let (dest, dest_ext) = match &existing {
            Some((p, e)) => (p.clone(), *e),
            None => (self.dir.join(format!("{sha}.{ext}")), ext),
        };
        // A boot-time `importDefault()` lands here every launch; only write if the stored copy
        // is missing or damaged.
        let intact = existing.is_some() && fs::read(&dest).is_ok_and(|old| old == bytes);
        if !intact {
            atomic_write(&self.dir, &dest, &bytes, before_rename)?;
        }

        let mut index = self.read_index();
        if let Some(record) = index.iter().find(|r| r.sha == sha) {
            return Ok(record.clone());
        }
        let record = SkinRecord {
            sha,
            name: record_name(path),
            family: family_of(dest_ext).to_string(),
            bytes: bytes.len() as u64,
            imported_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        index.push(record.clone());
        if let Err(e) = self.write_index(&index, before_rename) {
            if existing.is_none() {
                // Do not leave an archive the index never heard of.
                let _ = fs::remove_file(&dest);
            }
            return Err(e.into());
        }
        Ok(record)
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The stored archive for an already validated sha, whichever extension it was stored with.
    /// A symlink or directory planted in the store does not count.
    fn find_file(&self, sha: &str) -> Option<(PathBuf, &'static str)> {
        EXTENSIONS.iter().find_map(|ext| {
            let p = self.dir.join(format!("{sha}.{ext}"));
            let is_file = fs::symlink_metadata(&p)
                .map(|m| m.is_file())
                .unwrap_or(false);
            is_file.then_some((p, *ext))
        })
    }

    /// Entries that fail validation are dropped one by one; an index that is missing, too big
    /// or not JSON reads as empty.
    fn read_index(&self) -> Vec<SkinRecord> {
        #[derive(Deserialize)]
        struct IndexIn {
            #[serde(default)]
            skins: Vec<serde_json::Value>,
        }
        let Ok(file) = File::open(self.dir.join(INDEX_FILE)) else {
            return Vec::new();
        };
        let mut buf = Vec::new();
        if file
            .take(INDEX_MAX_BYTES + 1)
            .read_to_end(&mut buf)
            .is_err()
            || buf.len() as u64 > INDEX_MAX_BYTES
        {
            return Vec::new();
        }
        let Ok(parsed) = serde_json::from_slice::<IndexIn>(&buf) else {
            return Vec::new();
        };
        let mut out: Vec<SkinRecord> = Vec::new();
        for value in parsed.skins {
            let Ok(r) = serde_json::from_value::<SkinRecord>(value) else {
                continue;
            };
            let sane = is_valid_sha(&r.sha)
                && r.name.len() <= NAME_MAX_BYTES
                && FAMILIES.contains(&r.family.as_str());
            if sane && !out.iter().any(|seen| seen.sha == r.sha) {
                out.push(r);
            }
        }
        out
    }

    fn write_index(
        &self,
        records: &[SkinRecord],
        before_rename: &dyn Fn() -> io::Result<()>,
    ) -> io::Result<()> {
        #[derive(Serialize)]
        struct IndexOut<'a> {
            version: u32,
            skins: &'a [SkinRecord],
        }
        let body = serde_json::to_vec_pretty(&IndexOut {
            version: INDEX_VERSION,
            skins: records,
        })
        .map_err(io::Error::other)?;
        atomic_write(&self.dir, &self.dir.join(INDEX_FILE), &body, before_rename)
    }
}

/// Write `bytes` to a temp file in `dir`, flush it to disk, then rename it over `dest`. Any
/// failure, including one from `before_rename`, drops the temp file and leaves `dest` as it was.
/// The temp file lives in the destination directory so the rename never crosses a filesystem.
pub(crate) fn atomic_write(
    dir: &Path,
    dest: &Path,
    bytes: &[u8],
    before_rename: &dyn Fn() -> io::Result<()>,
) -> io::Result<()> {
    let mut tmp = tempfile::Builder::new().prefix(".tmp-").tempfile_in(dir)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    before_rename()?;
    tmp.persist(dest).map_err(|e| e.error)?;
    Ok(())
}

/// The lowercase extension when it is one of `.wmz`, `.wsz`, `.zip`.
fn allowed_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EXTENSIONS.iter().copied().find(|e| *e == ext)
}

fn family_of(ext: &str) -> &'static str {
    match ext {
        "wmz" => "wms",
        "wsz" => "wsz",
        _ => "unknown",
    }
}

/// Read a candidate file after the guard: not a symlink, a regular file, at most 32 MiB. The
/// path is checked with `lstat`, then the opened handle is checked again, so a swap between the
/// check and the open is caught rather than followed.
fn read_candidate(path: &Path) -> Result<Vec<u8>, SkinError> {
    let linked = fs::symlink_metadata(path)?;
    if linked.file_type().is_symlink() {
        return Err(SkinError::Symlink);
    }
    if !linked.is_file() {
        return Err(SkinError::NotRegularFile);
    }
    if linked.len() > MAX_ARCHIVE_BYTES {
        return Err(SkinError::TooLarge);
    }
    let file = File::open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || !same_file(&linked, &opened) {
        return Err(SkinError::NotRegularFile);
    }
    let mut bytes = Vec::with_capacity(opened.len().min(MAX_ARCHIVE_BYTES) as usize);
    // One byte past the cap catches a file that grew after the size check.
    file.take(MAX_ARCHIVE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(SkinError::TooLarge);
    }
    Ok(bytes)
}

#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(_a: &fs::Metadata, _b: &fs::Metadata) -> bool {
    true
}

/// A whole 22-byte end-of-central-directory record, signature first, inside the last 65,557
/// bytes. A signature with fewer than 22 bytes after it cannot be a record.
fn has_eocd(bytes: &[u8]) -> bool {
    let tail = &bytes[bytes.len().saturating_sub(EOCD_SEARCH_BYTES)..];
    if tail.len() < EOCD_LEN {
        return false;
    }
    let last_start = tail.len() - EOCD_LEN;
    tail[..last_start + EOCD_SIGNATURE.len()]
        .windows(EOCD_SIGNATURE.len())
        .any(|w| w == EOCD_SIGNATURE)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// The file stem with control characters removed and at most 255 bytes, never empty.
fn record_name(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut name: String = stem.chars().filter(|c| !c.is_control()).collect();
    while name.len() > NAME_MAX_BYTES {
        name.pop();
    }
    if name.trim().is_empty() {
        "skin".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use tempfile::TempDir;

    /// sha256 of `empty_zip()`, from `shasum -a 256`.
    const EMPTY_ZIP_SHA: &str = "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85";

    /// A zip with no entries: just the 22-byte end-of-central-directory record.
    fn empty_zip() -> Vec<u8> {
        let mut v = EOCD_SIGNATURE.to_vec();
        v.extend_from_slice(&[0; 18]);
        v
    }

    /// `empty_zip()` with a different body in front, so each call can make distinct bytes.
    fn zip_with(tag: &str) -> Vec<u8> {
        let mut v = tag.as_bytes().to_vec();
        v.extend_from_slice(&empty_zip());
        v
    }

    fn setup() -> (TempDir, SkinStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SkinStore::new(dir.path().join("appdata"));
        (dir, store)
    }

    /// Put `bytes` in a file called `name` in a scratch directory outside the store.
    fn source(dir: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();
        let p = src.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    fn store_dir_names(store: &SkinStore) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&store.dir)
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn fail_on_call(n: u32) -> impl Fn() -> io::Result<()> {
        let calls = Cell::new(0);
        move || {
            calls.set(calls.get() + 1);
            if calls.get() == n {
                Err(io::Error::other("simulated failure"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn import_names_the_file_by_sha_256_and_indexes_it() {
        let (dir, store) = setup();
        let rec = store
            .import(&source(&dir, "Headspace.wmz", &empty_zip()))
            .unwrap();
        assert_eq!(rec.sha, EMPTY_ZIP_SHA);
        assert_eq!(rec.name, "Headspace");
        assert_eq!(rec.family, "wms");
        assert_eq!(rec.bytes, 22);
        assert!(rec.imported_at > 1_600_000_000);
        assert_eq!(
            fs::read(store.dir.join(format!("{EMPTY_ZIP_SHA}.wmz"))).unwrap(),
            empty_zip()
        );
        assert_eq!(store.list(), vec![rec]);
        assert_eq!(
            store_dir_names(&store),
            vec![format!("{EMPTY_ZIP_SHA}.wmz"), "index.json".to_string()]
        );
    }

    #[test]
    fn index_is_versioned_json_that_round_trips() {
        let (dir, store) = setup();
        let rec = store.import(&source(&dir, "a.wsz", &empty_zip())).unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(&fs::read(store.dir.join("index.json")).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        let back: SkinRecord = serde_json::from_value(v["skins"][0].clone()).unwrap();
        assert_eq!(back, rec);
        assert_eq!(rec.family, "wsz");
    }

    #[test]
    fn reimporting_intact_bytes_writes_nothing() {
        let (dir, store) = setup();
        let first = store.import(&source(&dir, "a.wmz", &empty_zip())).unwrap();
        let again = store
            .import_with(&source(&dir, "a.wmz", &empty_zip()), &fail_on_call(1))
            .unwrap();
        assert_eq!(first, again);
    }

    #[test]
    fn importing_the_same_bytes_twice_makes_one_file_and_one_entry() {
        let (dir, store) = setup();
        let first = store
            .import(&source(&dir, "one.wmz", &empty_zip()))
            .unwrap();
        let second = store
            .import(&source(&dir, "two.wmz", &empty_zip()))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store_dir_names(&store),
            vec![format!("{EMPTY_ZIP_SHA}.wmz"), "index.json".to_string()]
        );
    }

    #[test]
    fn same_bytes_under_another_extension_reuse_the_stored_file() {
        let (dir, store) = setup();
        let first = store
            .import(&source(&dir, "one.wmz", &empty_zip()))
            .unwrap();
        let second = store
            .import(&source(&dir, "one.zip", &empty_zip()))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(second.family, "wms");
        assert_eq!(
            store_dir_names(&store),
            vec![format!("{EMPTY_ZIP_SHA}.wmz"), "index.json".to_string()]
        );
    }

    #[test]
    fn different_bytes_are_different_files_listed_in_import_order() {
        let (dir, store) = setup();
        let a = store
            .import(&source(&dir, "a.wmz", &zip_with("a")))
            .unwrap();
        let b = store
            .import(&source(&dir, "b.zip", &zip_with("b")))
            .unwrap();
        assert_ne!(a.sha, b.sha);
        assert_eq!(b.family, "unknown");
        assert_eq!(store.list(), vec![a, b]);
    }

    #[test]
    fn extension_is_case_insensitive_and_stored_lowercase() {
        let (dir, store) = setup();
        for (i, name) in ["a.WMZ", "b.Wsz", "c.ZIP"].iter().enumerate() {
            let rec = store
                .import(&source(&dir, name, &zip_with(&i.to_string())))
                .unwrap();
            let ext = &name[2..].to_ascii_lowercase();
            assert!(
                store.dir.join(format!("{}.{ext}", rec.sha)).is_file(),
                "{name}"
            );
        }
    }

    #[test]
    fn import_rejects_a_wrong_extension() {
        let (dir, store) = setup();
        for name in [
            "a.txt",
            "a",
            "a.wmz.txt",
            "a.wm",
            "a.wmzz",
            ".wmz",
            "a.zip.bak",
        ] {
            let err = store.import(&source(&dir, name, &empty_zip())).unwrap_err();
            assert!(matches!(err, SkinError::BadExtension), "{name}: {err}");
        }
        assert!(!store.dir.exists());
    }

    #[test]
    fn import_rejects_more_than_32_mib_and_accepts_exactly_32_mib() {
        let (dir, store) = setup();
        // A sparse file: the size check refuses it before anything is read.
        let big = source(&dir, "big.wmz", &[]);
        File::options()
            .write(true)
            .open(&big)
            .unwrap()
            .set_len(MAX_ARCHIVE_BYTES + 1)
            .unwrap();
        assert!(matches!(
            store.import(&big).unwrap_err(),
            SkinError::TooLarge
        ));
        assert!(!store.dir.exists());

        let mut exact = vec![0u8; MAX_ARCHIVE_BYTES as usize - EOCD_LEN];
        exact.extend_from_slice(&empty_zip());
        let rec = store.import(&source(&dir, "exact.wmz", &exact)).unwrap();
        assert_eq!(rec.bytes, MAX_ARCHIVE_BYTES);
        assert_eq!(
            store.read(&rec.sha).unwrap().len() as u64,
            MAX_ARCHIVE_BYTES
        );
    }

    #[cfg(unix)]
    #[test]
    fn import_rejects_a_symlink_even_to_a_valid_archive() {
        let (dir, store) = setup();
        let real = source(&dir, "real.wmz", &empty_zip());
        let link = dir.path().join("src").join("link.wmz");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(matches!(
            store.import(&link).unwrap_err(),
            SkinError::Symlink
        ));

        let dangling = dir.path().join("src").join("dangling.wmz");
        std::os::unix::fs::symlink(dir.path().join("nowhere"), &dangling).unwrap();
        assert!(matches!(
            store.import(&dangling).unwrap_err(),
            SkinError::Symlink
        ));
        assert!(!store.dir.exists());
    }

    #[test]
    fn import_rejects_a_directory_named_like_an_archive() {
        let (dir, store) = setup();
        let d = dir.path().join("looks-like.wmz");
        fs::create_dir(&d).unwrap();
        assert!(matches!(
            store.import(&d).unwrap_err(),
            SkinError::NotRegularFile
        ));
    }

    #[test]
    fn import_of_a_missing_file_is_an_io_error() {
        let (dir, store) = setup();
        let err = store.import(&dir.path().join("absent.wmz")).unwrap_err();
        assert!(
            matches!(err, SkinError::Io(ref e) if e.kind() == io::ErrorKind::NotFound),
            "{err}"
        );
    }

    #[test]
    fn import_rejects_a_file_with_no_end_of_central_directory() {
        let (dir, store) = setup();
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("empty", vec![]),
            ("text", b"this is not a zip".to_vec()),
            (
                "local header only",
                b"PK\x03\x04 and nothing else, padded out past 22 bytes".to_vec(),
            ),
            ("signature without a whole record", {
                let mut v = vec![0u8; 100];
                v.extend_from_slice(&EOCD_SIGNATURE);
                v.extend_from_slice(&[0; 17]);
                v
            }),
            ("short file", EOCD_SIGNATURE.to_vec()),
        ];
        for (label, bytes) in cases {
            let err = store.import(&source(&dir, "x.wmz", &bytes)).unwrap_err();
            assert!(matches!(err, SkinError::NoEocd), "{label}: {err}");
        }
    }

    #[test]
    fn eocd_must_start_within_the_last_65557_bytes() {
        let (dir, store) = setup();
        // The record plus a maximal 65,535-byte comment is exactly 65,557 bytes.
        let mut at_limit = empty_zip();
        at_limit.extend_from_slice(&vec![b'c'; 65_535]);
        assert_eq!(at_limit.len(), EOCD_SEARCH_BYTES);
        assert!(store.import(&source(&dir, "in.wmz", &at_limit)).is_ok());

        // One more byte after the record pushes its signature out of the window.
        let mut past_limit = at_limit.clone();
        past_limit.push(b'c');
        let err = store
            .import(&source(&dir, "out.wmz", &past_limit))
            .unwrap_err();
        assert!(matches!(err, SkinError::NoEocd), "{err}");
    }

    #[test]
    fn read_returns_the_stored_bytes() {
        let (dir, store) = setup();
        let bytes = zip_with("payload");
        let rec = store.import(&source(&dir, "a.wmz", &bytes)).unwrap();
        assert_eq!(store.read(&rec.sha).unwrap(), bytes);
    }

    #[test]
    fn read_rejects_anything_but_64_lowercase_hex_before_touching_disk() {
        let (dir, store) = setup();
        let rec = store.import(&source(&dir, "a.wmz", &empty_zip())).unwrap();
        // Planted where a traversal would land if the sha were not checked first.
        fs::write(dir.path().join("appdata").join("x.wmz"), empty_zip()).unwrap();
        let upper = rec.sha.to_ascii_uppercase();
        let long = format!("{}0", rec.sha);
        let cases = [
            "../x",
            "..",
            "",
            &rec.sha[..63],
            long.as_str(),
            upper.as_str(),
            "../skins/8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85",
            "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d8g",
            "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d8\u{e9}",
            "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d8\0",
            "8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d8/",
            " 739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85",
        ];
        for sha in cases {
            assert!(
                matches!(store.read(sha).unwrap_err(), SkinError::BadSha),
                "{sha:?}"
            );
        }
        assert!(store.read(&rec.sha).is_ok());
    }

    #[test]
    fn read_of_an_unknown_sha_is_not_found() {
        let (_dir, store) = setup();
        assert!(matches!(
            store.read(&"0".repeat(64)).unwrap_err(),
            SkinError::NotFound
        ));
    }

    #[test]
    fn read_reports_a_file_damaged_on_disk() {
        let (dir, store) = setup();
        let rec = store.import(&source(&dir, "a.wmz", &empty_zip())).unwrap();
        fs::write(store.dir.join(format!("{}.wmz", rec.sha)), b"damaged").unwrap();
        assert!(matches!(
            store.read(&rec.sha).unwrap_err(),
            SkinError::Corrupt
        ));
        // Importing the real bytes again repairs it.
        store.import(&source(&dir, "a.wmz", &empty_zip())).unwrap();
        assert_eq!(store.read(&rec.sha).unwrap(), empty_zip());
    }

    #[test]
    fn remove_deletes_the_file_and_the_entry() {
        let (dir, store) = setup();
        let a = store
            .import(&source(&dir, "a.wmz", &zip_with("a")))
            .unwrap();
        let b = store
            .import(&source(&dir, "b.wmz", &zip_with("b")))
            .unwrap();
        store.remove(&a.sha).unwrap();
        assert_eq!(store.list(), vec![b.clone()]);
        assert!(matches!(
            store.read(&a.sha).unwrap_err(),
            SkinError::NotFound
        ));
        assert!(store.read(&b.sha).is_ok());
        store.remove(&a.sha).unwrap();
    }

    #[test]
    fn remove_validates_the_sha_and_never_leaves_the_store() {
        let (dir, store) = setup();
        store.import(&source(&dir, "a.wmz", &empty_zip())).unwrap();
        let outside = dir.path().join("appdata").join("x.wmz");
        fs::write(&outside, b"keep me").unwrap();
        let upper = EMPTY_ZIP_SHA.to_ascii_uppercase();
        for sha in ["../x", "", "..", upper.as_str()] {
            assert!(
                matches!(store.remove(sha).unwrap_err(), SkinError::BadSha),
                "{sha:?}"
            );
        }
        assert!(outside.is_file());
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn a_failure_between_temp_write_and_rename_leaves_the_previous_file_intact() {
        let (dir, store) = setup();
        fs::create_dir_all(&store.dir).unwrap();
        let dest = store.dir.join(format!("{EMPTY_ZIP_SHA}.wmz"));
        fs::write(&dest, b"previous contents").unwrap();

        let err = store
            .import_with(&source(&dir, "a.wmz", &empty_zip()), &fail_on_call(1))
            .unwrap_err();
        assert!(matches!(err, SkinError::Io(_)), "{err}");
        assert_eq!(fs::read(&dest).unwrap(), b"previous contents");
        assert_eq!(
            store_dir_names(&store),
            vec![format!("{EMPTY_ZIP_SHA}.wmz")],
            "no temp file left"
        );
        assert!(store.list().is_empty());
    }

    #[test]
    fn a_failure_while_writing_the_index_keeps_the_previous_index_and_rolls_back_the_archive() {
        let (dir, store) = setup();
        let a = store
            .import(&source(&dir, "a.wmz", &zip_with("a")))
            .unwrap();
        let index_before = fs::read(store.dir.join("index.json")).unwrap();

        let b_bytes = zip_with("b");
        let err = store
            .import_with(&source(&dir, "b.wmz", &b_bytes), &fail_on_call(2))
            .unwrap_err();
        assert!(matches!(err, SkinError::Io(_)), "{err}");
        assert_eq!(
            fs::read(store.dir.join("index.json")).unwrap(),
            index_before
        );
        assert_eq!(store.list(), vec![a.clone()]);
        assert_eq!(
            store_dir_names(&store),
            vec![format!("{}.wmz", a.sha), "index.json".to_string()],
            "no orphan archive or temp file"
        );

        let b = store.import(&source(&dir, "b.wmz", &b_bytes)).unwrap();
        assert_eq!(store.list(), vec![a, b]);
    }

    #[test]
    fn a_missing_or_corrupt_index_lists_nothing_and_the_next_import_rewrites_it() {
        let (dir, store) = setup();
        assert!(store.list().is_empty());
        let a = store
            .import(&source(&dir, "a.wmz", &zip_with("a")))
            .unwrap();

        for junk in [
            &b"not json"[..],
            b"",
            b"{\"skins\": 7}",
            &vec![b' '; INDEX_MAX_BYTES as usize + 1],
        ] {
            fs::write(store.dir.join("index.json"), junk).unwrap();
            assert!(store.list().is_empty());
            assert!(
                store.read(&a.sha).is_ok(),
                "the archive is still readable by sha"
            );
        }
        let b = store
            .import(&source(&dir, "b.wmz", &zip_with("b")))
            .unwrap();
        assert_eq!(store.list(), vec![b]);
    }

    #[test]
    fn index_entries_with_bad_shas_unknown_families_or_duplicates_are_dropped() {
        let (dir, store) = setup();
        let a = store.import(&source(&dir, "a.wmz", &empty_zip())).unwrap();
        let entry = |sha: &str, family: &str| serde_json::json!({ "sha": sha, "name": "n", "family": family, "bytes": 1, "imported_at": 2 });
        let index = serde_json::json!({ "version": 1, "skins": [
            entry("../x", "wms"),
            entry(&a.sha.to_ascii_uppercase(), "wms"),
            entry(&a.sha, "elf"),
            serde_json::to_value(&a).unwrap(),
            serde_json::to_value(&a).unwrap(),
            serde_json::json!({ "sha": 5 }),
            serde_json::json!("junk"),
        ]});
        fs::write(store.dir.join("index.json"), index.to_string()).unwrap();
        assert_eq!(store.list(), vec![a]);
    }

    #[test]
    fn list_skips_entries_whose_archive_is_gone() {
        let (dir, store) = setup();
        let a = store
            .import(&source(&dir, "a.wmz", &zip_with("a")))
            .unwrap();
        let b = store
            .import(&source(&dir, "b.wmz", &zip_with("b")))
            .unwrap();
        fs::remove_file(store.dir.join(format!("{}.wmz", a.sha))).unwrap();
        assert_eq!(store.list(), vec![b]);
    }

    #[test]
    fn name_is_the_stem_without_control_characters_and_never_empty_or_over_255_bytes() {
        let (dir, store) = setup();
        let names = [
            ("__proto__.wmz", "__proto__"),
            ("constructor.zip", "constructor"),
            ("two.dots.wmz", "two.dots"),
            ("tab\there\u{7}.wmz", "tabhere"),
            ("\u{7}.wmz", "skin"),
        ];
        for (i, (file, want)) in names.iter().enumerate() {
            let rec = store
                .import(&source(&dir, file, &zip_with(&i.to_string())))
                .unwrap();
            assert_eq!(rec.name, *want, "{file}");
        }
        let long = format!("{}.wmz", "\u{e9}".repeat(120));
        let rec = store
            .import(&source(&dir, &long, &zip_with("long")))
            .unwrap();
        assert!(rec.name.len() <= NAME_MAX_BYTES);
        assert!(rec.name.chars().all(|c| c == '\u{e9}'));
    }

    #[test]
    fn concurrent_imports_all_reach_the_index() {
        let (dir, store) = setup();
        let store = std::sync::Arc::new(store);
        let paths: Vec<PathBuf> = (0..8)
            .map(|i| source(&dir, &format!("s{i}.wmz"), &zip_with(&format!("skin {i}"))))
            .collect();
        let handles: Vec<_> = paths
            .into_iter()
            .map(|p| {
                let store = store.clone();
                std::thread::spawn(move || store.import(&p).unwrap())
            })
            .collect();
        let mut made: Vec<SkinRecord> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let mut listed = store.list();
        made.sort_by(|a, b| a.sha.cmp(&b.sha));
        listed.sort_by(|a, b| a.sha.cmp(&b.sha));
        assert_eq!(listed, made);
        assert_eq!(listed.len(), 8);
    }

    #[test]
    fn sha_validator_matches_the_contract() {
        assert!(is_valid_sha(EMPTY_ZIP_SHA));
        assert!(!is_valid_sha(&EMPTY_ZIP_SHA.to_ascii_uppercase()));
        assert!(!is_valid_sha(&EMPTY_ZIP_SHA[1..]));
        assert!(!is_valid_sha(""));
    }
}
