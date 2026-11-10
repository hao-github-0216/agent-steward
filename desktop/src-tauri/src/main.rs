#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod i18n;
mod paths;
mod supervisor;
mod takeover;
mod updater;

use i18n::Lang;
use paths::{read_settings, Paths};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::Duration,
};
use supervisor::{Control, Logger};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Starting,
    Running,
    Stopped,
    Occupied(u16),
}

#[derive(Clone)]
pub struct View {
    pub status: Status,
    pub setup_failed: bool,
    pub autostart: bool,
    pub lang: Lang,
}

pub struct Desktop {
    pub paths: Paths,
    pub token: String,
    pub log: Logger,
    pub view: Mutex<View>,
    pub control: mpsc::Sender<Control>,
    pub stopping: AtomicBool,
    pub stop_terminals: AtomicBool,
    pub update_active: AtomicBool,
    pub desktop_state_lock: Mutex<()>,
    pub done: (Mutex<bool>, Condvar),
}

pub fn refresh_menu(app: &AppHandle, desktop: &Desktop) -> tauri::Result<()> {
    let view = desktop.view.lock().unwrap().clone();
    let lang = view.lang;
    let state = match view.status {
        Status::Starting => lang.text("starting").into(),
        Status::Running if view.setup_failed => lang.text("setup_failed").into(),
        Status::Running => lang.text("running").into(),
        Status::Stopped => lang.text("stopped").into(),
        Status::Occupied(port) => lang.port("occupied", port),
    };
    let title = format!(
        "{} v{} ● — {state}",
        lang.text("name"),
        app.package_info().version
    );
    let status = MenuItem::with_id(app, "status", title, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", lang.text("open"), true, None::<&str>)?;
    let terminal = MenuItem::with_id(app, "terminal", lang.text("terminal"), true, None::<&str>)?;
    let settings = read_settings(&desktop.paths.data);
    let mut access = Vec::new();
    if settings["access"]["tailscale"]["enabled"].as_bool() == Some(true) {
        access.push(lang.text("tailscale"));
    }
    if settings["access"]["lan"]["enabled"].as_bool() == Some(true) {
        access.push(lang.text("lan"));
    }
    if access.is_empty() {
        access.push(lang.text("off"));
    }
    let remote = MenuItem::with_id(
        app,
        "remote",
        format!("{}：{}", lang.text("remote"), access.join(" / ")),
        false,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let restart = MenuItem::with_id(app, "restart", lang.text("restart"), true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", lang.text("logs"), true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        lang.text("autostart"),
        true,
        view.autostart,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(app, "updates", lang.text("updates"), true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", lang.text("about"), true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", lang.text("quit"), true, None::<&str>)?;
    let quit_all = MenuItem::with_id(app, "quit_all", lang.text("quit_all"), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &open,
            &terminal,
            &remote,
            &separator,
            &restart,
            &logs,
            &autostart,
            &updates,
            &about,
            &separator2,
            &quit,
            &quit_all,
        ],
    )?;
    if let Some(tray) = app.tray_by_id("steward") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

pub fn set_status(app: &AppHandle, desktop: &Desktop, status: Status) {
    let changed = {
        let mut view = desktop.view.lock().unwrap();
        let changed = view.status != status;
        view.status = status;
        changed
    };
    if changed {
        desktop
            .log
            .write("desktop.log", &format!("status: {status:?}"));
        if let Err(error) = refresh_menu(app, desktop) {
            desktop.log.write("desktop.log", &format!("menu: {error}"));
        }
    }
}

pub fn show_error(app: &AppHandle, desktop: &Desktop, detail: &str) {
    desktop.log.write("desktop.log", detail);
    let lang = desktop.view.lock().unwrap().lang;
    app.dialog()
        .message(lang.text("error"))
        .title(lang.text("name"))
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom(lang.text("ok").into()))
        .show(|_| {});
}

pub fn open_browser(app: &AppHandle, desktop: &Desktop, fragment: &str) {
    if let Err(error) = app
        .opener()
        .open_url(desktop.paths.url(fragment), None::<&str>)
    {
        show_error(app, desktop, &format!("open browser: {error}"));
    }
}

pub fn apply_autostart(app: &AppHandle, desktop: &Desktop, on: bool) -> bool {
    let result = app.autolaunch().is_enabled().and_then(|enabled| {
        if enabled == on {
            Ok(())
        } else if on {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        }
    });
    match result {
        Ok(()) => {
            desktop.view.lock().unwrap().autostart = on;
            if let Err(error) = refresh_menu(app, desktop) {
                desktop.log.write("desktop.log", &format!("menu: {error}"));
            }
            true
        }
        Err(error) => {
            show_error(app, desktop, &format!("autostart: {error}"));
            false
        }
    }
}

pub fn mark_done(desktop: &Desktop) {
    *desktop.done.0.lock().unwrap() = true;
    desktop.done.1.notify_all();
}

fn wait_for_shutdown(desktop: &Desktop) {
    let _ = desktop.done.1.wait_timeout_while(
        desktop.done.0.lock().unwrap(),
        Duration::from_secs(4),
        |done| !*done,
    );
}

pub fn request_quit(app: &AppHandle, desktop: &Arc<Desktop>, close_terminals: bool) {
    if close_terminals {
        desktop.stop_terminals.store(true, Ordering::SeqCst);
    }
    if desktop.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = desktop.control.send(Control::Quit);
    let app = app.clone();
    let desktop = desktop.clone();
    std::thread::spawn(move || {
        wait_for_shutdown(&desktop);
        app.exit(0);
    });
}

fn menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let desktop = app.state::<Arc<Desktop>>().inner().clone();
    match event.id().as_ref() {
        "open" => open_browser(app, &desktop, ""),
        "terminal" => open_browser(app, &desktop, "#terminal"),
        "restart" => {
            let _ = desktop.control.send(Control::Restart);
        }
        "autostart" => {
            let on = !desktop.view.lock().unwrap().autostart;
            let _ = desktop.control.send(Control::Autostart(on));
        }
        "logs" => {
            if let Err(error) = app.opener().open_path(
                desktop.paths.data.join("logs").to_string_lossy(),
                None::<&str>,
            ) {
                show_error(app, &desktop, &format!("open logs: {error}"));
            }
        }
        "updates" => {
            updater::request_check(app, &desktop, updater::CheckMode::Manual);
        }
        "about" => {
            if let Err(error) = app.opener().open_path(
                desktop
                    .paths
                    .licenses
                    .join("THIRD_PARTY_NOTICES.md")
                    .to_string_lossy(),
                None::<&str>,
            ) {
                show_error(app, &desktop, &format!("open licenses: {error}"));
            }
        }
        "quit" => request_quit(app, &desktop, false),
        "quit_all" => request_quit(app, &desktop, true),
        _ => (),
    }
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
                open_browser(app, &desktop, "");
            }
        }))
        .plugin({
            let builder = tauri_plugin_autostart::Builder::new()
                .app_name("io.github.haogithub0216.agentsteward.desktop")
                .args(["--autostart"]);
            #[cfg(target_os = "macos")]
            let builder =
                builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
            builder.build()
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let paths = Paths::discover(app.handle())?;
            let settings = read_settings(&paths.data);
            let lang = Lang::detect(&settings, sys_locale::get_locale().as_deref());
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let token = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let (tx, rx) = mpsc::channel();
            let desktop = Arc::new(Desktop {
                log: Logger::new(paths.data.join("logs")),
                paths,
                token,
                view: Mutex::new(View {
                    status: Status::Starting,
                    setup_failed: false,
                    autostart: settings["desktop"]["autostart"].as_bool().unwrap_or(true),
                    lang,
                }),
                control: tx,
                stopping: AtomicBool::new(false),
                stop_terminals: AtomicBool::new(false),
                update_active: AtomicBool::new(false),
                desktop_state_lock: Mutex::new(()),
                done: (Mutex::new(false), Condvar::new()),
            });
            app.manage(desktop.clone());
            TrayIconBuilder::with_id("steward")
                .icon(
                    app.default_window_icon()
                        .ok_or("App icon is missing")?
                        .clone(),
                )
                .tooltip(lang.text("name"))
                .show_menu_on_left_click(cfg!(target_os = "macos"))
                .on_menu_event(menu_event)
                .on_tray_icon_event(|tray, event| {
                    #[cfg(windows)]
                    if matches!(
                        event,
                        tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        }
                    ) {
                        let app = tray.app_handle();
                        let desktop = app.state::<Arc<Desktop>>();
                        open_browser(app, &desktop, "");
                    }
                    #[cfg(not(windows))]
                    let _ = (tray, event);
                })
                .build(app)?;
            refresh_menu(app.handle(), &desktop)?;
            #[cfg(unix)]
            {
                let mut signals = signal_hook::iterator::Signals::new([
                    signal_hook::consts::SIGTERM,
                    signal_hook::consts::SIGINT,
                ])?;
                let app = app.handle().clone();
                let desktop = desktop.clone();
                std::thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        request_quit(&app, &desktop, false);
                    }
                });
            }
            let autostart = std::env::args().any(|arg| arg == "--autostart");
            supervisor::start(app.handle().clone(), desktop.clone(), rx, !autostart);
            updater::start(app.handle().clone(), desktop, autostart);
            Ok(())
        });
    let app = builder
        .build(tauri::generate_context!())
        .expect("Unable to start Agent Steward");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            } else if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
                desktop.stopping.store(true, Ordering::SeqCst);
                let _ = desktop.control.send(Control::Quit);
                wait_for_shutdown(&desktop);
            }
        }
        RunEvent::Exit => {
            if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
                desktop.stopping.store(true, Ordering::SeqCst);
                let _ = desktop.control.send(Control::Quit);
                wait_for_shutdown(&desktop);
            }
        }
        _ => (),
    });
}
