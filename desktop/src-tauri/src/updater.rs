use crate::{
    paths::read_settings,
    supervisor::{self, Control},
    Desktop, Status,
};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::Path,
    sync::{atomic::Ordering, mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const DAY: u64 = 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CheckMode {
    Automatic,
    Manual,
}

#[derive(Default, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopState {
    pub update_prompt: Option<UpdatePrompt>,
    pub herdr_version: Option<String>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct UpdatePrompt {
    pub version: String,
    pub at: u64,
}

pub fn read_state(data: &Path) -> DesktopState {
    fs::read(data.join("desktop-state.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn write_state(data: &Path, state: &DesktopState) -> io::Result<()> {
    fs::create_dir_all(data)?;
    let temporary = data.join(format!("desktop-state.{}.tmp", std::process::id()));
    let result = (|| {
        fs::write(&temporary, serde_json::to_vec_pretty(state)?)?;
        fs::rename(&temporary, data.join("desktop-state.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn change_state(desktop: &Desktop, change: impl FnOnce(&mut DesktopState)) {
    let _lock = desktop.desktop_state_lock.lock().unwrap();
    let mut state = read_state(&desktop.paths.data);
    change(&mut state);
    if let Err(error) = write_state(&desktop.paths.data, &state) {
        desktop
            .log
            .write("desktop.log", &format!("desktop state: {error}"));
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn startup_delay(autostart: bool, test_override: bool) -> Duration {
    Duration::from_secs(if test_override {
        0
    } else if autostart {
        600
    } else {
        180
    })
}

pub fn automatic_due(
    enabled: bool,
    healthy_for: Option<Duration>,
    since_check: Option<Duration>,
    autostart: bool,
    test_override: bool,
) -> bool {
    enabled
        && healthy_for.is_some_and(|elapsed| elapsed >= startup_delay(autostart, test_override))
        && since_check.is_none_or(|elapsed| elapsed >= Duration::from_secs(DAY))
}

pub fn should_prompt(
    mode: CheckMode,
    version: &str,
    last: Option<&UpdatePrompt>,
    now: u64,
) -> bool {
    mode == CheckMode::Manual
        || last.is_none_or(|last| last.version != version || now.saturating_sub(last.at) >= DAY)
}

struct CheckGuard(Arc<Desktop>);
impl Drop for CheckGuard {
    fn drop(&mut self) {
        self.0.update_active.store(false, Ordering::SeqCst);
    }
}

fn message(app: &AppHandle, desktop: &Desktop, key: &str, version: Option<&str>, error: bool) {
    let lang = desktop.view.lock().unwrap().lang;
    app.dialog()
        .message(lang.text(key).replace("{version}", version.unwrap_or("")))
        .title(lang.text("name"))
        .kind(if error {
            MessageDialogKind::Error
        } else {
            MessageDialogKind::Info
        })
        .buttons(MessageDialogButtons::OkCustom(lang.text("ok").into()))
        .show(|_| {});
}

pub fn request_check(app: &AppHandle, desktop: &Arc<Desktop>, mode: CheckMode) -> bool {
    if desktop.stopping.load(Ordering::SeqCst) {
        return false;
    }
    if desktop.update_active.swap(true, Ordering::SeqCst) {
        if mode == CheckMode::Manual {
            message(app, desktop, "update_busy", None, false);
        }
        return false;
    }
    let app = app.clone();
    let desktop = desktop.clone();
    thread::spawn(move || {
        let guard = CheckGuard(desktop.clone());
        check(&app, &desktop, mode, guard);
    });
    true
}

fn check(app: &AppHandle, desktop: &Arc<Desktop>, mode: CheckMode, guard: CheckGuard) {
    if mode == CheckMode::Automatic
        && read_settings(&desktop.paths.data)["desktop"]["autoUpdate"].as_bool() == Some(false)
    {
        return;
    }
    let stopped = Arc::new(Mutex::new(false));
    let builder = app.updater_builder().timeout(Duration::from_secs(120));
    #[cfg(windows)]
    let builder = {
        let app = app.clone();
        let desktop = desktop.clone();
        let stopped = stopped.clone();
        builder.on_before_exit(move || {
            if let Err(error) = stop_for_install(&desktop, &stopped) {
                desktop
                    .log
                    .write("desktop.log", &format!("updater exit hook: {error}"));
            }
            app.cleanup_before_exit();
        })
    };
    let updater = match builder.build() {
        Ok(updater) => updater,
        Err(tauri_plugin_updater::Error::EmptyEndpoints) => {
            if mode == CheckMode::Manual {
                message(app, desktop, "update_development", None, false);
            }
            return;
        }
        Err(error) => {
            check_failed(app, desktop, mode, &error.to_string());
            return;
        }
    };
    desktop.log.write("desktop.log", "checking for App updates");
    match tauri::async_runtime::block_on(updater.check()) {
        Err(error) => check_failed(app, desktop, mode, &error.to_string()),
        Ok(None) => {
            desktop.log.write("desktop.log", "App is up to date");
            if mode == CheckMode::Manual {
                message(
                    app,
                    desktop,
                    "update_current",
                    Some(&app.package_info().version.to_string()),
                    false,
                );
            }
        }
        Ok(Some(mut update)) => {
            update.timeout = Some(Duration::from_secs(300));
            if desktop.stopping.load(Ordering::SeqCst) {
                return;
            }
            let now = unix_seconds();
            if !should_prompt(
                mode,
                &update.version,
                read_state(&desktop.paths.data).update_prompt.as_ref(),
                now,
            ) {
                desktop
                    .log
                    .write("desktop.log", "update prompt already shown today");
                return;
            }
            change_state(desktop, |state| {
                state.update_prompt = Some(UpdatePrompt {
                    version: update.version.clone(),
                    at: now,
                });
            });
            prompt(app, desktop, update, stopped, guard);
        }
    }
}

fn check_failed(app: &AppHandle, desktop: &Desktop, mode: CheckMode, detail: &str) {
    desktop
        .log
        .write("desktop.log", &format!("update check failed: {detail}"));
    if mode == CheckMode::Manual {
        message(app, desktop, "update_check_error", None, true);
    }
}

fn prompt(
    app: &AppHandle,
    desktop: &Arc<Desktop>,
    update: Update,
    stopped: Arc<Mutex<bool>>,
    guard: CheckGuard,
) {
    match std::env::var("STEWARD_DESKTOP_UPDATE").ok().as_deref() {
        Some("accept") => {
            install_update(app.clone(), desktop.clone(), update, stopped, guard);
            return;
        }
        Some("decline") => {
            desktop.log.write("desktop.log", "App update declined");
            return;
        }
        _ => (),
    }
    let close_herdr = cfg!(windows) && supervisor::herdr_in_app(&desktop.paths);
    let lang = desktop.view.lock().unwrap().lang;
    let text = lang
        .text(if close_herdr {
            "update_windows_herdr"
        } else {
            "update_available"
        })
        .replace("{new}", &update.version)
        .replace("{current}", &update.current_version);
    let yes = lang.text("update_install").to_string();
    let notes = lang.text("update_notes").to_string();
    let buttons = if close_herdr {
        MessageDialogButtons::OkCancelCustom(yes.clone(), lang.text("update_later").into())
    } else {
        MessageDialogButtons::YesNoCancelCustom(
            yes.clone(),
            lang.text("update_later").into(),
            notes.clone(),
        )
    };
    let app_handle = app.clone();
    let desktop = desktop.clone();
    app.dialog()
        .message(text)
        .title(lang.text("name"))
        .kind(MessageDialogKind::Warning)
        .buttons(buttons)
        .show_with_result(move |result| {
            if matches!(result, MessageDialogResult::Yes | MessageDialogResult::Ok)
                || result == MessageDialogResult::Custom(yes)
            {
                install_update(app_handle, desktop, update, stopped, guard);
            } else if result == MessageDialogResult::Custom(notes) {
                let url = format!(
                    "https://github.com/hao-github-0216/agent-steward/releases/tag/v{}",
                    update.version
                );
                if let Err(error) = app_handle.opener().open_url(url, None::<&str>) {
                    desktop
                        .log
                        .write("desktop.log", &format!("open release notes: {error}"));
                }
            }
        });
}

trait UpdateSteps {
    type Bytes;
    fn download(&mut self) -> Result<Self::Bytes, String>;
    fn stop(&mut self) -> Result<(), String>;
    fn install(&mut self, bytes: Self::Bytes) -> Result<(), String>;
    fn restart(&mut self) -> Result<(), String>;
    fn resume_services(&mut self);
}

fn run_update(steps: &mut impl UpdateSteps) -> Result<(), String> {
    let bytes = steps.download()?;
    let result = steps
        .stop()
        .and_then(|()| steps.install(bytes))
        .and_then(|()| steps.restart());
    if result.is_err() {
        steps.resume_services();
    }
    result
}

fn stop_for_install(desktop: &Desktop, stopped: &Mutex<bool>) -> Result<(), String> {
    let mut stopped = stopped.lock().unwrap();
    if *stopped {
        return Ok(());
    }
    if desktop.stopping.load(Ordering::SeqCst) {
        return Err("App is shutting down".into());
    }
    let (tx, rx) = mpsc::channel();
    desktop
        .control
        .send(Control::StopForUpdate(tx))
        .map_err(|error| error.to_string())?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|error| format!("waiting for services to stop: {error}"))?;
    #[cfg(windows)]
    if supervisor::herdr_in_app(&desktop.paths) {
        supervisor::stop_herdr(desktop);
    }
    *stopped = true;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
const RELAUNCH_SCRIPT: &str = r#"pid="$1"
shift
attempts=0
while kill -0 "$pid" 2>/dev/null; do
    if [ "$attempts" -ge 150 ]; then exit 1; fi
    sleep 0.2
    attempts=$((attempts + 1))
done
exec "$@""#;

#[cfg(any(target_os = "macos", test))]
fn relaunch_args(
    pid: u32,
    executable: &Path,
    args: &[std::ffi::OsString],
) -> Vec<std::ffi::OsString> {
    let mut result = vec![
        "-c".into(),
        RELAUNCH_SCRIPT.into(),
        "steward-relaunch".into(),
        pid.to_string().into(),
        executable.as_os_str().to_owned(),
    ];
    result.extend_from_slice(args);
    result
}

#[cfg(target_os = "macos")]
fn relaunch(app: &AppHandle, desktop: &Arc<Desktop>) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    Command::new("/bin/sh")
        .args(relaunch_args(std::process::id(), &executable, &args))
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("start relaunch helper: {error}"))?;
    crate::request_quit(app, desktop, false);
    Ok(())
}

struct AppUpdate {
    app: AppHandle,
    desktop: Arc<Desktop>,
    update: Update,
    stopped: Arc<Mutex<bool>>,
}
impl UpdateSteps for AppUpdate {
    type Bytes = Vec<u8>;
    fn download(&mut self) -> Result<Vec<u8>, String> {
        self.desktop.log.write(
            "desktop.log",
            "downloading App update (services remain running)",
        );
        let bytes = tauri::async_runtime::block_on(self.update.download(|_, _| {}, || {}))
            .map_err(|error| format!("download/verify: {error}"))?;
        self.desktop.log.write(
            "desktop.log",
            "App update downloaded and signature verified",
        );
        Ok(bytes)
    }
    fn stop(&mut self) -> Result<(), String> {
        stop_for_install(&self.desktop, &self.stopped)
    }
    fn install(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        if self.desktop.stopping.load(Ordering::SeqCst) {
            return Err("App is shutting down".into());
        }
        self.desktop
            .log
            .write("desktop.log", "installing verified App update");
        self.update
            .install(bytes)
            .map_err(|error| format!("install: {error}"))
    }
    fn restart(&mut self) -> Result<(), String> {
        self.desktop
            .log
            .write("desktop.log", "App update installed; restarting App");
        #[cfg(target_os = "macos")]
        {
            relaunch(&self.app, &self.desktop)
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        self.app.restart();
        #[cfg(windows)]
        Ok(())
    }
    fn resume_services(&mut self) {
        let (tx, rx) = mpsc::channel();
        if self
            .desktop
            .control
            .send(Control::ResumeAfterUpdate(tx))
            .is_ok()
        {
            match rx.recv_timeout(Duration::from_secs(10)) {
                Ok(()) => *self.stopped.lock().unwrap() = false,
                Err(error) => self
                    .desktop
                    .log
                    .write("desktop.log", &format!("resume after update: {error}")),
            }
        }
    }
}

fn install_update(
    app: AppHandle,
    desktop: Arc<Desktop>,
    update: Update,
    stopped: Arc<Mutex<bool>>,
    guard: CheckGuard,
) {
    thread::spawn(move || {
        let _guard = guard;
        let mut steps = AppUpdate {
            app,
            desktop,
            update,
            stopped,
        };
        if let Err(error) = run_update(&mut steps) {
            steps
                .desktop
                .log
                .write("desktop.log", &format!("App update failed: {error}"));
            message(
                &steps.app,
                &steps.desktop,
                "update_install_error",
                None,
                true,
            );
        }
    });
}

pub fn check_herdr_version(app: &AppHandle, desktop: &Arc<Desktop>) {
    let result = desktop
        .paths
        .command(&desktop.paths.herdr, &desktop.token)
        .arg("--version")
        .output();
    let version = match result {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        result => {
            desktop
                .log
                .write("desktop.log", &format!("bundled herdr version: {result:?}"));
            return;
        }
    };
    if version.is_empty() {
        return;
    }
    let mut changed = false;
    change_state(desktop, |state| {
        changed = state
            .herdr_version
            .as_ref()
            .is_some_and(|previous| previous != &version);
        state.herdr_version = Some(version);
    });
    if !changed || !supervisor::herdr_running(desktop) {
        return;
    }
    let lang = desktop.view.lock().unwrap().lang;
    let desktop = desktop.clone();
    app.dialog()
        .message(lang.text("herdr_updated"))
        .title(lang.text("name"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            lang.text("herdr_restart").into(),
            lang.text("herdr_later").into(),
        ))
        .show(move |accepted| {
            if accepted {
                thread::spawn(move || supervisor::stop_herdr(&desktop));
            }
        });
}

pub fn start(app: AppHandle, desktop: Arc<Desktop>, autostart: bool) {
    thread::spawn(move || {
        let test_override = std::env::var_os("STEWARD_DESKTOP_UPDATE").is_some();
        let mut healthy_since = None;
        let mut last_check: Option<Instant> = None;
        while !desktop.stopping.load(Ordering::SeqCst) {
            if desktop.view.lock().unwrap().status == Status::Running {
                let since = healthy_since.get_or_insert_with(Instant::now);
                let enabled = read_settings(&desktop.paths.data)["desktop"]["autoUpdate"]
                    .as_bool()
                    .unwrap_or(true);
                if automatic_due(
                    enabled,
                    Some(since.elapsed()),
                    last_check.map(|at| at.elapsed()),
                    autostart,
                    test_override,
                ) && request_check(&app, &desktop, CheckMode::Automatic)
                {
                    last_check = Some(Instant::now());
                }
            }
            thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_and_autostart_delays_and_test_override() {
        assert_eq!(startup_delay(false, false).as_secs(), 180);
        assert_eq!(startup_delay(true, false).as_secs(), 600);
        for autostart in [false, true] {
            assert_eq!(startup_delay(autostart, true), Duration::ZERO);
        }
        assert!(!automatic_due(true, None, None, false, true));
        assert!(!automatic_due(
            true,
            Some(Duration::from_secs(179)),
            None,
            false,
            false
        ));
        assert!(automatic_due(
            true,
            Some(Duration::from_secs(180)),
            None,
            false,
            false
        ));
        assert!(!automatic_due(
            true,
            Some(Duration::from_secs(599)),
            None,
            true,
            false
        ));
        assert!(automatic_due(
            true,
            Some(Duration::from_secs(600)),
            None,
            true,
            false
        ));
        assert!(automatic_due(true, Some(Duration::ZERO), None, true, true));
    }
    #[test]
    fn auto_update_setting_and_daily_interval() {
        assert!(!automatic_due(
            false,
            Some(Duration::from_secs(DAY * 2)),
            None,
            false,
            true
        ));
        assert!(!automatic_due(
            true,
            Some(Duration::from_secs(DAY * 2)),
            Some(Duration::from_secs(DAY - 1)),
            false,
            false
        ));
        assert!(automatic_due(
            true,
            Some(Duration::from_secs(DAY * 2)),
            Some(Duration::from_secs(DAY)),
            false,
            false
        ));
    }
    #[test]
    fn prompt_once_per_version_per_day_but_manual_is_unrestricted() {
        let last = UpdatePrompt {
            version: "0.0.2".into(),
            at: 100,
        };
        assert!(!should_prompt(
            CheckMode::Automatic,
            "0.0.2",
            Some(&last),
            100 + DAY - 1
        ));
        assert!(!should_prompt(
            CheckMode::Automatic,
            "0.0.2",
            Some(&last),
            99
        ));
        assert!(should_prompt(
            CheckMode::Automatic,
            "0.0.2",
            Some(&last),
            100 + DAY
        ));
        assert!(should_prompt(CheckMode::Manual, "0.0.2", Some(&last), 101));
        assert!(should_prompt(
            CheckMode::Automatic,
            "0.0.3",
            Some(&last),
            101
        ));
        assert!(should_prompt(CheckMode::Automatic, "0.0.2", None, 101));
    }
    #[test]
    fn state_round_trip_and_corruption() {
        let data = std::env::temp_dir().join(format!(
            "steward-state-{}-{}",
            std::process::id(),
            unix_seconds()
        ));
        fs::create_dir_all(&data).unwrap();
        assert_eq!(read_state(&data), DesktopState::default());
        fs::write(data.join("desktop-state.json"), b"broken json").unwrap();
        assert_eq!(read_state(&data), DesktopState::default());
        let state = DesktopState {
            update_prompt: Some(UpdatePrompt {
                version: "1.2.3".into(),
                at: 123,
            }),
            herdr_version: Some("herdr 0.9.5".into()),
            other: serde_json::Map::from_iter([("kept".into(), true.into())]),
        };
        write_state(&data, &state).unwrap();
        assert_eq!(read_state(&data), state);
        write_state(&data, &DesktopState::default()).unwrap();
        assert_eq!(read_state(&data), DesktopState::default());
        fs::remove_dir_all(data).unwrap();
    }
    #[test]
    fn relaunch_passes_executable_and_arguments_as_literal_positional_parameters() {
        use std::ffi::OsString;
        let executable = Path::new(
            "/tmp/Update App's folder/Agent Steward.app/Contents/MacOS/agent-steward-desktop",
        );
        let args = vec![
            OsString::from("--autostart"),
            OsString::from("space ; $(touch unwanted) ' "),
        ];
        let command = relaunch_args(4321, executable, &args);
        assert_eq!(command[0], "-c");
        assert_eq!(command[1], RELAUNCH_SCRIPT);
        assert_eq!(command[2], "steward-relaunch");
        assert_eq!(command[3], "4321");
        assert_eq!(command[4], executable.as_os_str());
        assert_eq!(&command[5..], &args);
        assert!(!RELAUNCH_SCRIPT.contains(executable.to_str().unwrap()));
        assert!(RELAUNCH_SCRIPT.contains("exec \"$@\""));
        assert!(RELAUNCH_SCRIPT.contains("kill -0 \"$pid\""));
        assert!(RELAUNCH_SCRIPT.contains("-ge 150"));
    }
    #[cfg(unix)]
    #[test]
    fn relaunch_shell_preserves_spaces_and_metacharacters() {
        use std::ffi::OsString;
        let args = [
            OsString::from("%s"),
            OsString::from("two words; $(echo not-executed) ' quote"),
        ];
        let output = std::process::Command::new("/bin/sh")
            .args(relaunch_args(
                i32::MAX as u32,
                Path::new("/usr/bin/printf"),
                &args,
            ))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, args[1].as_encoded_bytes());
    }

    struct FakeSteps {
        calls: Vec<&'static str>,
        download_fails: bool,
        install_fails: bool,
    }
    impl UpdateSteps for FakeSteps {
        type Bytes = ();
        fn download(&mut self) -> Result<(), String> {
            self.calls.push("download");
            if self.download_fails {
                Err("invalid signature".into())
            } else {
                Ok(())
            }
        }
        fn stop(&mut self) -> Result<(), String> {
            self.calls.push("stop");
            Ok(())
        }
        fn install(&mut self, _: ()) -> Result<(), String> {
            self.calls.push("install");
            if self.install_fails {
                Err("cannot install".into())
            } else {
                Ok(())
            }
        }
        fn restart(&mut self) -> Result<(), String> {
            self.calls.push("restart");
            Ok(())
        }
        fn resume_services(&mut self) {
            self.calls.push("resume");
        }
    }
    #[test]
    fn download_failure_never_stops_services() {
        let mut steps = FakeSteps {
            calls: vec![],
            download_fails: true,
            install_fails: false,
        };
        assert!(run_update(&mut steps).is_err());
        assert_eq!(steps.calls, ["download"]);
    }
    #[test]
    fn install_failure_resumes_services() {
        let mut steps = FakeSteps {
            calls: vec![],
            download_fails: false,
            install_fails: true,
        };
        assert!(run_update(&mut steps).is_err());
        assert_eq!(steps.calls, ["download", "stop", "install", "resume"]);
    }
    #[test]
    fn successful_update_follows_the_required_order() {
        let mut steps = FakeSteps {
            calls: vec![],
            download_fails: false,
            install_fails: false,
        };
        assert!(run_update(&mut steps).is_ok());
        assert_eq!(steps.calls, ["download", "stop", "install", "restart"]);
    }
}
