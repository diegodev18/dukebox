// Windows would otherwise open a console window behind the app in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dukebox_lib::run()
}
