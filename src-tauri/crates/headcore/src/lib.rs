//! The pure Rust core of the skin engine (ENGINE.md §6.2). It has no Tauri dependency, so
//! `cargo test --manifest-path src-tauri/Cargo.toml -p headcore` runs without building the app;
//! the Tauri glue that calls it lives in `src-tauri/src/*_cmds.rs`.

pub mod fanout;
pub mod guards;
pub mod hit;
pub mod prefstore;
pub mod skinstore;
