use crate::{i18n::Lang, paths::Paths, supervisor::Logger};
use std::{env, fs, io};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub fn launchctl_path(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("path = ")
            .map(|path| path.trim().trim_matches('"').to_string())
            .filter(|path| !path.is_empty())
    })
}

pub fn owns_registration(output: &str, expected: &std::path::Path) -> bool {
    launchctl_path(output).as_deref() == expected.to_str()
}

pub fn take_over(app: &AppHandle, paths: &Paths, lang: Lang, log: &Logger) -> io::Result<bool> {
    if !detected(paths) {
        return Ok(true);
    }
    let accepted = match env::var("STEWARD_DESKTOP_TAKEOVER").ok().as_deref() {
        Some("accept") => true,
        Some("decline") => false,
        _ => app
            .dialog()
            .message(lang.text("takeover"))
            .title(lang.text("name"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                lang.text("takeover_accept").into(),
                lang.text("takeover_decline").into(),
            ))
            .blocking_show(),
    };
    if !accepted {
        log.write("desktop.log", "takeover declined; exiting App");
        return Ok(false);
    }
    remove_old_services(paths, log)?;
    log.write(
        "desktop.log",
        "takeover complete; old app, node, and bin directories were preserved",
    );
    Ok(true)
}

#[cfg(target_os = "macos")]
fn detected(paths: &Paths) -> bool {
    paths
        .home
        .join("Library/LaunchAgents/com.agent-steward.plist")
        .exists()
}

#[cfg(windows)]
fn detected(_: &Paths) -> bool {
    crate::paths::quiet_command("schtasks.exe")
        .args(["/Query", "/TN", "agent-steward"])
        .output()
        .is_ok_and(|out| out.status.success())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn detected(_: &Paths) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn remove_old_services(paths: &Paths, log: &Logger) -> io::Result<()> {
    use crate::paths::quiet_command;
    let uid = unsafe { libc::getuid() };
    for label in ["com.agent-steward", "com.agent-steward.terminal"] {
        let expected = paths
            .home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
        let target = format!("gui/{uid}/{label}");
        let registered = quiet_command("launchctl")
            .args(["print", &target])
            .output()?;
        let output = String::from_utf8_lossy(&registered.stdout);
        if registered.status.success() && owns_registration(&output, &expected) {
            let stopped = quiet_command("launchctl")
                .args(["bootout", &target])
                .output()?;
            log.write(
                "desktop.log",
                &format!("bootout {target}: {}", stopped.status),
            );
            if !stopped.status.success() {
                return Err(io::Error::other(format!(
                    "bootout failed: {}",
                    String::from_utf8_lossy(&stopped.stderr)
                )));
            }
        } else {
            log.write(
                "desktop.log",
                &format!(
                    "skip bootout {target}: path mismatch (registered: {:?}, expected: {})",
                    launchctl_path(&output),
                    expected.display()
                ),
            );
        }
        match fs::remove_file(&expected) {
            Ok(()) => log.write("desktop.log", &format!("removed {}", expected.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn remove_old_services(paths: &Paths, log: &Logger) -> io::Result<()> {
    use crate::paths::quiet_command;
    for task in ["agent-steward", "agent-steward-terminal"] {
        for args in [
            vec!["/End", "/TN", task],
            vec!["/Delete", "/F", "/TN", task],
        ] {
            let result = quiet_command("schtasks.exe").args(&args).output()?;
            log.write(
                "desktop.log",
                &format!("schtasks {}: {}", args.join(" "), result.status),
            );
        }
    }
    let script = r#"
$root = [IO.Path]::GetFullPath((Join-Path $env:STEWARD_TAKEOVER_HOME '.agent-steward')).TrimEnd('\') + '\'
$app = $root + 'app\'
$ttyd = $root + 'bin\ttyd.exe'
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -ieq 'node.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
    ($_.Name -ieq 'ttyd.exe' -and $_.ExecutablePath -ieq $ttyd) -or
    ($_.Name -ieq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match 'run-service\.ps1')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
"#;
    let result = quiet_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("STEWARD_TAKEOVER_HOME", &paths.home)
        .output()?;
    log.write(
        "desktop.log",
        &format!("stopped old installation processes: {}", result.status),
    );
    if !result.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&result.stderr).to_string(),
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn remove_old_services(_: &Paths, _: &Logger) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_launchctl_path_without_confusing_program_or_nested_values() {
        let text = "gui/501/com.agent-steward = {\n    path = /private/tmp/test home/Library/LaunchAgents/com.agent-steward.plist\n    state = running\n    program = /bin/sh\n}";
        let expected = std::path::Path::new(
            "/private/tmp/test home/Library/LaunchAgents/com.agent-steward.plist",
        );
        assert_eq!(launchctl_path(text).as_deref(), expected.to_str());
        assert!(owns_registration(text, expected));
        assert!(!owns_registration(
            text,
            std::path::Path::new("/Users/real/Library/LaunchAgents/com.agent-steward.plist")
        ));
        assert_eq!(launchctl_path("program = /bin/node\nstate = running"), None);
        assert_eq!(
            launchctl_path("path = \"/tmp/a b.plist\"").as_deref(),
            Some("/tmp/a b.plist")
        );
    }
}
