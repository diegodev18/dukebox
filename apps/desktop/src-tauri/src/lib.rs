/// The native shell.
///
/// Kept deliberately thin: a window, credential storage, the deep link that
/// carries a pairing code, and the plumbing for self-updates. Everything else
/// is the frontend's job, so there is one place to look when behaviour
/// changes.
///
/// Nothing about a particular installation is compiled in. The app learns
/// which server to talk to from the pairing link, which is what lets one
/// published binary serve everyone.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Where the device token lives. The plugin uses the OS keychain, so
        // the token is not sitting in a file next to the app.
        .plugin(tauri_plugin_store::Builder::new().build())
        // HTTP from the native process rather than the webview. macOS refuses
        // plaintext HTTP from a webview, and a tailnet address has no
        // certificate a browser would accept, so this is the only path that
        // reaches a Dukebox server at all.
        .plugin(tauri_plugin_http::init())
        // Opens a pull request in the user's browser rather than in the app.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Self-updates: checks the GitHub release feed, downloads a signed
            // bundle, and restarts into it, plus the process control to
            // perform that restart. Desktop-only, so gated the way the plugin
            // docs recommend rather than unconditionally.
            #[cfg(desktop)]
            {
                let _ = app.handle().plugin(tauri_plugin_process::init());
                let _ = app
                    .handle()
                    .plugin(tauri_plugin_updater::Builder::new().build());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Dukebox");
}
