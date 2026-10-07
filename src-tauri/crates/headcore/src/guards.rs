//! Page-hardening guards for the two IPC commands that reach outside the app (ENGINE.md §7).
//!
//! The page realm is a webview, and a compromise of it would otherwise own the `mpd` command (any
//! MPD verb, including `rm`, `sendmessage`, `password`, `kill`) and `record_stop` (an arbitrary
//! file write). These two predicates shrink that to the verbs the app uses and to a few
//! scratch-space directories. Both fail closed.

use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// Every verb `player.js`, `playlist.js` and `demo.js` send, plus the mode verbs (`repeat`,
/// `random`, `single`, `consume`). Anything else is refused before it reaches the socket.
pub const MPD_ALLOWED_VERBS: [&str; 18] = [
    "status",
    "currentsong",
    "playlistinfo",
    "listplaylists",
    "listplaylistinfo",
    "play",
    "pause",
    "stop",
    "next",
    "previous",
    "seekcur",
    "setvol",
    "clear",
    "load",
    "repeat",
    "random",
    "single",
    "consume",
];

/// True only for an exact, case-sensitive match of an allowed verb. No trimming and no case
/// folding: `"STATUS"`, `"status "` and `"play\nclear"` are all refused, because the verb is the
/// first word of a line the MPD client writes verbatim.
pub fn mpd_verb_allowed(verb: &str) -> bool {
    MPD_ALLOWED_VERBS.contains(&verb)
}

/// Whether `record_stop` may write a WAV at `path`: an absolute path to a regular file (or to a
/// file that does not exist yet) directly inside `/tmp`, `/private/tmp`, `tmpdir` (`$TMPDIR`) or
/// `<home>/Movies`, or anywhere beneath one of them.
///
/// The parent directory is canonicalised before it is compared with the (canonicalised) roots, so
/// a symlinked directory under `/tmp` that points elsewhere is refused, and so is the macOS
/// `/tmp` -> `/private/tmp` hop being compared the wrong way round. A target that already exists
/// must be a regular file, which refuses a symlink there too: `File::create` would follow it.
/// `..` is refused lexically before any of that.
///
/// `tmpdir` and `home` are parameters, not read from the environment, so the check is testable
/// and a missing `$HOME` simply leaves `~/Movies` out. A root that is relative, missing, or the
/// filesystem root is ignored rather than trusted.
///
/// This is a check, not a lock: the file can still be swapped between this call and the write by
/// someone who can already write into those directories.
pub fn record_path_allowed(path: &Path, tmpdir: Option<&Path>, home: Option<&Path>) -> bool {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    // A trailing slash names a directory, never a WAV.
    if path.as_os_str().to_string_lossy().ends_with('/') {
        return false;
    }
    let (Some(_), Some(parent)) = (path.file_name(), path.parent()) else {
        return false;
    };

    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => {}
        Ok(_) => return false, // a symlink, a directory, a FIFO or a device
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(_) => return false, // includes a NUL byte in the path
    }

    // The file does not exist yet on the happy path, so the parent is what gets resolved.
    let Ok(parent) = fs::canonicalize(parent) else {
        return false;
    };
    allowed_roots(tmpdir, home)
        .iter()
        .any(|root| parent.starts_with(root))
}

/// The canonical form of each root that exists. `Path::starts_with` is component-wise, so a root
/// of `/tmp` does not admit `/tmpfoo`.
fn allowed_roots(tmpdir: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let literal = ["/tmp", "/private/tmp"].map(PathBuf::from);
    literal
        .into_iter()
        .chain(tmpdir.map(Path::to_path_buf))
        .chain(home.map(|h| h.join("Movies")))
        .filter(|root| root.is_absolute())
        .filter_map(|root| fs::canonicalize(root).ok())
        // A `$TMPDIR` of `/` would admit every path on the machine.
        .filter(|root| root.parent().is_some())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ---- mpd_verb_allowed ----

    #[test]
    fn the_allow_list_is_exactly_the_one_in_the_spec() {
        // Typed out here independently of the constant, so editing one without the other fails.
        let spec = [
            "status",
            "currentsong",
            "playlistinfo",
            "listplaylists",
            "listplaylistinfo",
            "play",
            "pause",
            "stop",
            "next",
            "previous",
            "seekcur",
            "setvol",
            "clear",
            "load",
            "repeat",
            "random",
            "single",
            "consume",
        ];
        assert_eq!(MPD_ALLOWED_VERBS, spec);
    }

    #[test]
    fn every_allowed_verb_passes() {
        for verb in MPD_ALLOWED_VERBS {
            assert!(mpd_verb_allowed(verb), "{verb}");
        }
    }

    #[test]
    fn dangerous_and_unlisted_verbs_fail() {
        for verb in [
            "rm",
            "sendmessage",
            "password",
            "kill",
            "update",
            "config",
            "",
            // Verbs the app does not use, including neighbours of allowed ones.
            "add",
            "addid",
            "delete",
            "save",
            "playlist",
            "playid",
            "stopid",
            "idle",
            "close",
            "subscribe",
            "command_list_begin",
            "command_list_ok_begin",
            "listall",
            "outputs",
            "disableoutput",
            "shuffle",
            // Skin-controlled-looking strings.
            "__proto__",
            "constructor",
        ] {
            assert!(!mpd_verb_allowed(verb), "{verb:?}");
        }
    }

    #[test]
    fn matching_is_exact() {
        for verb in [
            "STATUS",
            "Status",
            " status",
            "status ",
            "status\n",
            "status\0",
            "play\nclear",
            "play clear",
            "pla",
            "plays",
            "playlistinfo2",
            "seek",
            "\u{ff53}tatus", // fullwidth s
        ] {
            assert!(!mpd_verb_allowed(verb), "{verb:?}");
        }
    }

    // ---- record_path_allowed ----

    /// A scratch directory outside every built-in root, so a fixture that should be refused is
    /// not accepted just because `$TMPDIR` is `/tmp` (Linux) or because of where tempfile puts it.
    fn outside_scratch() -> TempDir {
        tempfile::tempdir_in("/var/tmp").expect("/var/tmp must be writable for these tests")
    }

    fn allowed(path: &Path, tmpdir: Option<&Path>, home: Option<&Path>) -> bool {
        record_path_allowed(path, tmpdir, home)
    }

    #[test]
    fn tmp_is_accepted() {
        assert!(allowed(Path::new("/tmp/a.wav"), None, None));
        // The demo's default (`demo.js`).
        assert!(allowed(
            Path::new("/tmp/window_headmpd-demo.wav"),
            None,
            None
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn private_tmp_is_accepted() {
        assert!(allowed(Path::new("/private/tmp/a.wav"), None, None));
    }

    #[test]
    fn a_subdirectory_of_tmp_is_accepted() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        assert!(allowed(&dir.path().join("a.wav"), None, None));
    }

    #[test]
    fn tmpdir_is_accepted_only_when_given() {
        let scratch = outside_scratch();
        let tmpdir = scratch.path().join("T");
        fs::create_dir(&tmpdir).unwrap();
        let file = tmpdir.join("a.wav");

        assert!(allowed(&file, Some(&tmpdir), None));
        assert!(!allowed(&file, None, None), "not under any built-in root");
        // Another directory given as TMPDIR does not admit this one.
        let other = scratch.path().join("other");
        fs::create_dir(&other).unwrap();
        assert!(!allowed(&file, Some(&other), None));
    }

    #[test]
    fn tmpdir_with_a_trailing_slash_and_a_symlinked_prefix_is_accepted() {
        // macOS `$TMPDIR` is `/var/folders/.../T/`, and `/var` is a symlink to `/private/var`.
        let scratch = outside_scratch();
        let real = scratch.path().join("real");
        fs::create_dir(&real).unwrap();
        let alias = scratch.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();

        let mut with_slash = alias.clone().into_os_string();
        with_slash.push("/");
        let with_slash = PathBuf::from(with_slash);

        assert!(allowed(&alias.join("a.wav"), Some(&with_slash), None));
        assert!(allowed(&real.join("a.wav"), Some(&with_slash), None));
        assert!(allowed(&alias.join("a.wav"), Some(&real), None));
    }

    #[test]
    fn home_movies_is_accepted_and_the_rest_of_home_is_not() {
        let home = outside_scratch();
        fs::create_dir_all(home.path().join("Movies/demos")).unwrap();
        fs::create_dir(home.path().join("Documents")).unwrap();
        let h = Some(home.path());

        assert!(allowed(&home.path().join("Movies/a.wav"), None, h));
        assert!(allowed(&home.path().join("Movies/demos/a.wav"), None, h));
        assert!(!allowed(&home.path().join("Documents/a.wav"), None, h));
        assert!(
            !allowed(&home.path().join("a.wav"), None, h),
            "home itself is not a root"
        );
        assert!(
            !allowed(&home.path().join("Movies/a.wav"), None, None),
            "no HOME, no Movies"
        );
        // `Movies` must be exactly that: a sibling that merely starts with it is refused.
        fs::create_dir(home.path().join("Movies2")).unwrap();
        assert!(!allowed(&home.path().join("Movies2/a.wav"), None, h));
    }

    #[test]
    fn a_missing_movies_directory_is_refused_not_created() {
        let home = outside_scratch();
        assert!(!allowed(
            &home.path().join("Movies/a.wav"),
            None,
            Some(home.path())
        ));
        assert!(!home.path().join("Movies").exists());
    }

    #[test]
    fn a_symlinked_movies_directory_is_followed_on_both_sides() {
        // `~/Movies` pointing at an external drive is common.
        let home = outside_scratch();
        let drive = outside_scratch();
        std::os::unix::fs::symlink(drive.path(), home.path().join("Movies")).unwrap();
        assert!(allowed(
            &home.path().join("Movies/a.wav"),
            None,
            Some(home.path())
        ));
    }

    #[test]
    fn paths_outside_the_roots_are_refused() {
        assert!(!allowed(Path::new("/etc/x"), None, None));
        assert!(!allowed(Path::new("/etc/passwd"), None, None));
        assert!(!allowed(Path::new("/usr/a.wav"), None, None));
        assert!(!allowed(Path::new("/a.wav"), None, None));
        assert!(!allowed(Path::new("/"), None, None));
        let outside = outside_scratch();
        assert!(!allowed(&outside.path().join("a.wav"), None, None));
    }

    #[test]
    fn dot_dot_is_refused() {
        assert!(!allowed(Path::new("/tmp/../etc/x"), None, None));
        assert!(!allowed(Path::new("/tmp/.."), None, None));
        assert!(
            !allowed(Path::new("/tmp/../tmp/a.wav"), None, None),
            "even when it stays inside"
        );
        let home = outside_scratch();
        fs::create_dir_all(home.path().join("Movies")).unwrap();
        fs::create_dir(home.path().join("Documents")).unwrap();
        let sneaky = home.path().join("Movies/../Documents/a.wav");
        assert!(!allowed(&sneaky, None, Some(home.path())));
    }

    #[test]
    fn a_sibling_that_shares_a_prefix_with_a_root_is_refused() {
        // Component-wise comparison: `…/T` admits `…/T/a.wav` but not `…/Tfoo/a.wav`.
        let scratch = outside_scratch();
        let root = scratch.path().join("T");
        let sibling = scratch.path().join("Tfoo");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        assert!(allowed(&root.join("a.wav"), Some(&root), None));
        assert!(!allowed(&sibling.join("a.wav"), Some(&root), None));
    }

    #[test]
    fn a_symlinked_directory_pointing_outside_is_refused() {
        // Both sides are real directories here, one of them under /tmp and one in no root.
        let inside = tempfile::tempdir_in("/tmp").unwrap();
        let outside = outside_scratch();
        std::os::unix::fs::symlink(outside.path(), inside.path().join("link")).unwrap();
        std::os::unix::fs::symlink("/usr", inside.path().join("usr")).unwrap();

        // Positive control, so the refusals below are about the link and not the fixture.
        assert!(allowed(&inside.path().join("a.wav"), None, None));
        assert!(!allowed(&inside.path().join("link/a.wav"), None, None));
        assert!(!allowed(&inside.path().join("usr/a.wav"), None, None));
        // Nested beneath the link as well.
        fs::create_dir(outside.path().join("deeper")).unwrap();
        assert!(!allowed(
            &inside.path().join("link/deeper/a.wav"),
            None,
            None
        ));
    }

    #[test]
    fn a_symlinked_directory_pointing_inside_is_accepted() {
        // Resolution, not symlink-hostility: the destination is what is judged.
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("alias")).unwrap();
        assert!(allowed(&dir.path().join("alias/a.wav"), None, None));
    }

    #[test]
    fn a_symlink_as_the_file_itself_is_refused() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let outside = outside_scratch();
        let victim = outside.path().join("victim.wav");
        fs::write(&victim, b"keep me").unwrap();

        std::os::unix::fs::symlink(&victim, dir.path().join("to-file.wav")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("nope.wav"),
            dir.path().join("dangling.wav"),
        )
        .unwrap();
        // Even a symlink that resolves to somewhere allowed is refused: `File::create` follows it.
        fs::write(dir.path().join("real.wav"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("real.wav"), dir.path().join("alias.wav"))
            .unwrap();

        assert!(!allowed(&dir.path().join("to-file.wav"), None, None));
        assert!(!allowed(&dir.path().join("dangling.wav"), None, None));
        assert!(!allowed(&dir.path().join("alias.wav"), None, None));
        // An existing regular file is overwritten by a re-run, which is allowed.
        assert!(allowed(&dir.path().join("real.wav"), None, None));
        assert_eq!(fs::read(&victim).unwrap(), b"keep me");
    }

    #[test]
    fn directories_and_odd_targets_are_refused() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        assert!(!allowed(dir.path(), None, None), "the directory itself");
        assert!(!allowed(&dir.path().join("sub"), None, None));

        let mut slash = dir.path().join("sub").into_os_string();
        slash.push("/");
        assert!(!allowed(Path::new(&slash), None, None));
        let mut dot = dir.path().join("sub").into_os_string();
        dot.push("/.");
        assert!(!allowed(Path::new(&dot), None, None));

        assert!(!allowed(Path::new("/tmp"), None, None), "its parent is `/`");
        assert!(!allowed(Path::new("/tmp/"), None, None));
        assert!(!allowed(Path::new("/private/tmp"), None, None));
    }

    #[test]
    fn relative_empty_and_unresolvable_paths_are_refused() {
        assert!(!allowed(Path::new(""), None, None));
        assert!(!allowed(Path::new("a.wav"), None, None));
        assert!(!allowed(Path::new("./a.wav"), None, None));
        assert!(!allowed(Path::new("tmp/a.wav"), None, None));
        // `~` is not expanded here; the path would be written relative to the cwd.
        assert!(!allowed(Path::new("~/Movies/a.wav"), None, None));
        assert!(!allowed(
            Path::new("/tmp/headcore-no-such-dir/a.wav"),
            None,
            None
        ));
        assert!(!allowed(Path::new("/tmp/a\0.wav"), None, None));
    }

    #[test]
    fn a_degenerate_root_is_ignored() {
        let outside = outside_scratch();
        let file = outside.path().join("a.wav");
        // `$TMPDIR=/` would admit everything, an empty or relative one means nothing.
        assert!(!allowed(&file, Some(Path::new("/")), None));
        assert!(!allowed(&file, Some(Path::new("")), Some(Path::new(""))));
        assert!(!allowed(
            &file,
            Some(Path::new("T")),
            Some(Path::new("home"))
        ));
        assert!(!allowed(
            Path::new("/usr/a.wav"),
            Some(Path::new("/")),
            Some(Path::new("/"))
        ));
        // A root that does not exist admits nothing, and breaks nothing.
        assert!(!allowed(&file, Some(&outside.path().join("missing")), None));
        assert!(allowed(
            Path::new("/tmp/a.wav"),
            Some(Path::new("/")),
            Some(Path::new("/nope"))
        ));
    }
}
