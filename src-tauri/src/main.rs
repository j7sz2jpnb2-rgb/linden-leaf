// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| {
        a == "--native-messaging-host"
            || a.starts_with("chrome-extension://")
            || a.starts_with("extension://")
    }) {
        let code = linden_leaf_lib::run_native_messaging_host();
        std::process::exit(code);
    }
    #[cfg(debug_assertions)]
    {
        if std::env::var("LINDEN_DEV_REMOTE_DEBUG").is_ok() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9226");
        }
    }
    linden_leaf_lib::run();
}
