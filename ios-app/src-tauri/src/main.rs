// 桌面版入口:在 Mac 上先跑起來測;iPhone 走 lib.rs 的 mobile_entry_point
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_steward_app_lib::run()
}
