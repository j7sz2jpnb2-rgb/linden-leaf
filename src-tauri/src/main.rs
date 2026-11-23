// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(debug_assertions)]
    {
        if std::env::var("LINDEN_DEV_REMOTE_DEBUG").is_ok() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9226");
        }
    }
    linden_leaf_lib::run();
}
