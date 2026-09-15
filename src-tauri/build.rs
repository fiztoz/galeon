fn main() {
    tauri_build::build();
    // tauri-winres embeds the Common Controls v6 manifest on *bins* only.
    // Without it, Windows `cargo test` fails to start the harness with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139). Same workaround as
    // tauri-apps/tauri#13419 / PR #4383: embed the manifest on test binaries.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
