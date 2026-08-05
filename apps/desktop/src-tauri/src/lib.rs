/// The native shell.
///
/// Kept deliberately thin: a window, credential storage, and the deep link
/// that carries a pairing code. Everything else is the frontend's job, so
/// there is one place to look when behaviour changes.
///
/// Nothing about a particular installation is compiled in. The app learns
/// which server to talk to from the pairing link, which is what lets one
/// published binary serve everyone.
use tauri::Manager;

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
            #[cfg(debug_assertions)]
            {
                // Devtools in development only. A released app that ships them
                // hands anyone who opens it a console into the running window.
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Dukebox");
}
