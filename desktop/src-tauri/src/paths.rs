use serde::Deserialize;
use serde_json::Value;
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct Paths {
    pub home: PathBuf,
    pub data: PathBuf,
    pub app: PathBuf,
    pub licenses: PathBuf,
    pub node: PathBuf,
    pub herdr: PathBuf,
    pub ttyd: PathBuf,
    pub port: u16,
    pub terminal_port: u16,
}

pub fn read_settings(data: &Path) -> Value {
    fs::read(data.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn valid_port(value: &str) -> Option<u16> {
    value.parse::<u16>().ok().filter(|port| *port != 0)
}

pub fn decide_port(environment: Option<&str>, settings: Option<u64>, fallback: u16) -> u16 {
    environment
        .and_then(valid_port)
        .or_else(|| {
            settings
                .and_then(|value| u16::try_from(value).ok())
                .filter(|port| *port != 0)
        })
        .unwrap_or(fallback)
}

impl Paths {
    pub fn discover(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let home = PathBuf::from(
            env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("HOME/USERPROFILE is not set")?,
        );
        if !home.is_absolute() {
            return Err("HOME/USERPROFILE must be absolute".into());
        }
        let data = env::var_os("STEWARD_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".agent-steward"));
        if !data.is_absolute() {
            return Err("STEWARD_DATA_DIR must be absolute".into());
        }
        let settings = read_settings(&data);
        let resources = app.path().resource_dir()?;
        let executable = env::current_exe()?;
        let bin = executable
            .parent()
            .ok_or("Cannot locate bundled executables")?;
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let paths = Self {
            home,
            data,
            app: resources.join("app"),
            licenses: resources.join("licenses"),
            node: bin.join(format!("node{suffix}")),
            herdr: if cfg!(windows) {
                resources.join("herdr/herdr.exe")
            } else {
                bin.join("herdr")
            },
            ttyd: bin.join(format!("ttyd{suffix}")),
            port: decide_port(
                env::var("STEWARD_PORT").ok().as_deref(),
                settings["server"]["port"].as_u64(),
                8791,
            ),
            terminal_port: decide_port(
                env::var("STEWARD_TERMINAL_PORT").ok().as_deref(),
                settings["server"]["terminalPort"].as_u64(),
                8792,
            ),
        };
        fs::create_dir_all(paths.data.join("logs"))?;
        Ok(paths)
    }

    pub fn url(&self, fragment: &str) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, fragment)
    }

    pub fn command(&self, executable: &Path, token: &str) -> Command {
        let mut command = quiet_command(executable);
        for (key, _) in env::vars_os() {
            if key.to_string_lossy().starts_with("HERDR_") {
                command.env_remove(key);
            }
        }
        let mut path = vec![
            self.node.parent().unwrap().to_path_buf(),
            self.home.join(".local/bin"),
        ];
        if let Some(existing) = env::var_os("PATH") {
            path.extend(env::split_paths(&existing));
        }
        command
            .current_dir(&self.app)
            .env("STEWARD_DESKTOP", "1")
            .env("STEWARD_DATA_DIR", &self.data)
            .env("STEWARD_APP_DIR", &self.app)
            .env("STEWARD_NODE", &self.node)
            .env("HERDR_BIN_PATH", &self.herdr)
            .env("STEWARD_TTYD_BIN", &self.ttyd)
            .env("STEWARD_DESKTOP_TOKEN", token)
            .env("STEWARD_PORT", self.port.to_string())
            .env("STEWARD_TERMINAL_PORT", self.terminal_port.to_string());
        if let Ok(path) = env::join_paths(path) {
            command.env("PATH", path);
        }
        command
    }

    pub fn node_command(&self, script: &str, token: &str) -> Command {
        let mut command = self.command(&self.node, token);
        command
            .args(["--experimental-strip-types", "--no-warnings"])
            .arg(self.app.join("src").join(script));
        command
    }
}

pub fn quiet_command(executable: impl AsRef<std::ffi::OsStr>) -> Command {
    let command = Command::new(executable);
    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    };
    command
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct TtydPid {
    pub pid: u32,
    pub exe: PathBuf,
}

pub fn parse_ttyd_pid(text: &str) -> Option<TtydPid> {
    let record: TtydPid = serde_json::from_str(text).ok()?;
    (record.pid > 1 && record.exe.is_absolute()).then_some(record)
}

pub fn same_executable(a: &Path, b: &Path) -> bool {
    let a = fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let b = fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

#[cfg(target_os = "macos")]
pub fn process_executable(pid: u32) -> Option<PathBuf> {
    #[link(name = "proc")]
    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
    }
    let mut buffer = vec![0_u8; 4096];
    let length = unsafe {
        proc_pidpath(
            i32::try_from(pid).ok()?,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0)?;
    use std::os::unix::ffi::OsStringExt;
    Some(PathBuf::from(std::ffi::OsString::from_vec(
        buffer[..end].to_vec(),
    )))
}

#[cfg(windows)]
pub fn process_executable(pid: u32) -> Option<PathBuf> {
    let output = quiet_command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command",
        &format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').ExecutablePath | ConvertTo-Json -Compress")]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice::<String>(&output.stdout)
        .ok()
        .map(PathBuf::from)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn process_executable(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
}

pub fn signal_process(pid: u32, force: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        let pid = i32::try_from(pid)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"))?;
        if unsafe { libc::kill(pid, if force { libc::SIGKILL } else { libc::SIGTERM }) } == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(windows)]
    {
        let mut command = quiet_command("taskkill.exe");
        command.args(["/PID", &pid.to_string()]);
        if force {
            command.arg("/F");
        }
        if !command.status()?.success() {
            return Err(io::Error::other("taskkill failed"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn port_precedence_and_invalid_values() {
        assert_eq!(decide_port(Some("18951"), Some(12345), 8791), 18951);
        assert_eq!(decide_port(None, Some(12345), 8791), 12345);
        assert_eq!(decide_port(None, None, 8791), 8791);
        for value in ["", "0", "65536", "-1", "oops"] {
            assert_eq!(decide_port(Some(value), Some(12345), 8791), 12345);
        }
        assert_eq!(decide_port(None, Some(0), 8792), 8792);
        assert_eq!(decide_port(None, Some(65536), 8792), 8792);
    }
    #[test]
    fn ttyd_pid_requires_a_real_pid_and_absolute_path() {
        let exe = if cfg!(windows) {
            r"C:\App\ttyd.exe"
        } else {
            "/App/ttyd"
        };
        let record =
            parse_ttyd_pid(&serde_json::json!({ "pid": 123, "exe": exe }).to_string()).unwrap();
        assert_eq!(record.pid, 123);
        assert_eq!(record.exe, PathBuf::from(exe));
        for text in [
            "",
            "{}",
            r#"{"pid":0,"exe":"/App/ttyd"}"#,
            r#"{"pid":-2,"exe":"/App/ttyd"}"#,
            r#"{"pid":12,"exe":"ttyd"}"#,
            r#"{"pid":"12","exe":"/App/ttyd"}"#,
        ] {
            assert!(parse_ttyd_pid(text).is_none(), "{text}");
        }
    }
}
