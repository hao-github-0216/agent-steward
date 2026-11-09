use crate::{
    apply_autostart,
    i18n::Lang,
    mark_done, open_browser,
    paths::{
        parse_ttyd_pid, process_executable, read_settings, same_executable, signal_process, Paths,
    },
    refresh_menu, set_status, show_error, takeover, Desktop, Status,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{
        atomic::Ordering,
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const LOG_LIMIT: u64 = 5 * 1024 * 1024;
const BACKOFF: [u64; 5] = [1, 2, 5, 10, 30];

#[derive(Clone)]
pub struct Logger {
    directory: PathBuf,
    lock: Arc<Mutex<()>>,
}
impl Logger {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            lock: Arc::new(Mutex::new(())),
        }
    }
    pub fn write(&self, filename: &str, message: &str) {
        let _guard = self.lock.lock().unwrap();
        let result = (|| -> io::Result<()> {
            fs::create_dir_all(&self.directory)?;
            let path = self.directory.join(filename);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let line = format!("[{timestamp}] {message}\n");
            if fs::metadata(&path).is_ok_and(|meta| meta.len() + line.len() as u64 > LOG_LIMIT) {
                let previous = self.directory.join(format!("{filename}.1"));
                match fs::remove_file(&previous) {
                    Ok(()) => (),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error),
                }
                fs::rename(&path, previous)?;
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?
                .write_all(line.as_bytes())
        })();
        if let Err(error) = result {
            eprintln!("desktop log: {error}");
        }
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum DesktopSignal {
    Autostart {
        on: Option<bool>,
    },
    Lang {
        lang: Option<String>,
    },
    Setup {
        ok: bool,
        #[serde(default)]
        notes: Vec<String>,
    },
}
pub fn parse_signal(line: &str) -> Option<DesktopSignal> {
    serde_json::from_str(line.strip_prefix("@@desktop ")?).ok()
}

pub enum Control {
    Quit,
    Restart,
    Autostart(bool),
    Signal(DesktopSignal),
    OutputClosed,
}

#[derive(Default)]
pub struct RestartPolicy {
    failures: VecDeque<Duration>,
    attempts: usize,
}
impl RestartPolicy {
    pub fn failed(&mut self, now: Duration) -> Option<Duration> {
        while self
            .failures
            .front()
            .is_some_and(|at| now.saturating_sub(*at) > Duration::from_secs(120))
        {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        let delay = Duration::from_secs(BACKOFF[self.attempts.min(BACKOFF.len() - 1)]);
        self.attempts += 1;
        (self.failures.len() < 5).then_some(delay)
    }
}

fn capture(
    reader: impl Read + Send + 'static,
    filename: &'static str,
    log: Logger,
    sender: Sender<Control>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) if line.starts_with("@@desktop ") => {
                    if let Some(signal) = parse_signal(&line) {
                        let _ = sender.send(Control::Signal(signal));
                    } else {
                        log.write("desktop.log", &format!("invalid desktop message: {line}"));
                    }
                }
                Ok(line) => log.write(filename, &line),
                Err(error) => {
                    log.write("desktop.log", &format!("read {filename}: {error}"));
                    break;
                }
            }
        }
        let _ = sender.send(Control::OutputClosed);
    });
}

struct Service {
    script: &'static str,
    stdout_log: &'static str,
    stderr_log: &'static str,
    child: Option<Child>,
    started: Instant,
    next_start: Instant,
    policy: RestartPolicy,
    stopped: bool,
}
impl Service {
    fn new(script: &'static str, stdout_log: &'static str, stderr_log: &'static str) -> Self {
        Self {
            script,
            stdout_log,
            stderr_log,
            child: None,
            started: Instant::now(),
            next_start: Instant::now(),
            policy: RestartPolicy::default(),
            stopped: false,
        }
    }
    fn failed(&mut self, desktop: &Desktop, epoch: Instant) {
        match self.policy.failed(epoch.elapsed()) {
            Some(delay) => {
                self.next_start = Instant::now() + delay;
                desktop.log.write(
                    "desktop.log",
                    &format!("{}: restart in {}s", self.script, delay.as_secs()),
                );
            }
            None => {
                self.stopped = true;
                desktop.log.write(
                    "desktop.log",
                    &format!(
                        "{}: 5 failures within 120s; automatic restarts stopped",
                        self.script
                    ),
                );
            }
        }
    }
    fn launch(&mut self, desktop: &Desktop, epoch: Instant) {
        if self.child.is_some() || self.stopped || Instant::now() < self.next_start {
            return;
        }
        let result = desktop
            .paths
            .node_command(self.script, &desktop.token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        match result {
            Ok(mut child) => {
                desktop.log.write(
                    "desktop.log",
                    &format!("started {} pid={}", self.script, child.id()),
                );
                capture(
                    child.stdout.take().unwrap(),
                    self.stdout_log,
                    desktop.log.clone(),
                    desktop.control.clone(),
                );
                capture(
                    child.stderr.take().unwrap(),
                    self.stderr_log,
                    desktop.log.clone(),
                    desktop.control.clone(),
                );
                self.started = Instant::now();
                self.child = Some(child);
            }
            Err(error) => {
                desktop
                    .log
                    .write("desktop.log", &format!("start {}: {error}", self.script));
                self.failed(desktop, epoch);
            }
        }
    }
    fn poll(&mut self, desktop: &Desktop, epoch: Instant) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        match child.try_wait() {
            Ok(None) => {
                if self.started.elapsed() > Duration::from_secs(120) {
                    self.policy = RestartPolicy::default();
                }
            }
            result => {
                desktop.log.write(
                    "desktop.log",
                    &format!("{} exited: {result:?}", self.script),
                );
                if result.is_err() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                self.child = None;
                if self.script == "terminal-runner.ts" {
                    cleanup_ttyd(&desktop.paths, &desktop.log, true);
                }
                self.failed(desktop, epoch);
            }
        }
    }
    fn reset(&mut self) {
        self.policy = RestartPolicy::default();
        self.stopped = false;
        self.next_start = Instant::now();
    }
}

fn stop_services(services: &mut [Service], desktop: &Desktop) {
    for service in services.iter_mut() {
        if let Some(child) = service.child.as_mut() {
            drop(child.stdin.take());
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mut running = false;
        for service in services.iter_mut() {
            if let Some(child) = service.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(_)) => service.child = None,
                    _ => running = true,
                }
            }
        }
        if !running || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    for service in services.iter_mut() {
        if let Some(mut child) = service.child.take() {
            desktop.log.write(
                "desktop.log",
                &format!("forcing {} pid={} to stop", service.script, child.id()),
            );
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if services
        .iter()
        .any(|service| service.script == "terminal-runner.ts")
    {
        cleanup_ttyd(&desktop.paths, &desktop.log, true);
    }
}

pub fn cleanup_ttyd(paths: &Paths, log: &Logger, force: bool) {
    let file = paths.data.join("run/ttyd.pid");
    let Some(record) = fs::read_to_string(&file)
        .ok()
        .and_then(|text| parse_ttyd_pid(&text))
    else {
        return;
    };
    if !same_executable(&record.exe, &paths.ttyd) {
        log.write(
            "desktop.log",
            "ttyd.pid belongs to another executable; left untouched",
        );
        return;
    }
    let matching =
        || process_executable(record.pid).is_some_and(|exe| same_executable(&exe, &paths.ttyd));
    if !matching() {
        log.write(
            "desktop.log",
            "ttyd.pid is stale or its process executable does not match; left untouched",
        );
        return;
    }
    log.write(
        "desktop.log",
        &format!("stopping leftover bundled ttyd pid={}", record.pid),
    );
    if let Err(error) = signal_process(record.pid, force) {
        log.write("desktop.log", &format!("stop ttyd: {error}"));
        return;
    }
    if !force {
        let deadline = Instant::now() + Duration::from_millis(500);
        while matching() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if matching() {
            let _ = signal_process(record.pid, true);
        }
    }
    let _ = fs::remove_file(file);
}

pub struct HttpReply {
    pub status: u16,
    pub json: Value,
}
pub fn request(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> io::Result<HttpReply> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_millis(500))?;
    socket.set_read_timeout(Some(Duration::from_secs(1)))?;
    socket.set_write_timeout(Some(Duration::from_secs(1)))?;
    let body = body.unwrap_or("");
    let mut headers = format!("{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", body.len());
    if let Some(token) = token {
        headers.push_str(&format!("x-steward-desktop: {token}\r\n"));
    }
    socket.write_all(format!("{headers}\r\n{body}").as_bytes())?;
    let mut response = String::new();
    socket.take(256 * 1024).read_to_string(&mut response)?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::other("not an HTTP response"))?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| io::Error::other("invalid HTTP status"))?;
    Ok(HttpReply {
        status,
        json: serde_json::from_str(body).unwrap_or(Value::Null),
    })
}

#[derive(Debug, PartialEq)]
enum Health {
    Absent,
    Desktop,
    Occupied,
}
fn health(port: u16) -> Health {
    match request(port, "GET", "/api/health", None, None) {
        Ok(reply)
            if reply.status == 200
                && reply.json["ok"] == true
                && reply.json["mode"] == "desktop" =>
        {
            Health::Desktop
        }
        Ok(_) => Health::Occupied,
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => Health::Absent,
        Err(_) => Health::Occupied,
    }
}
fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(300),
    )
    .is_ok()
}

fn run_setup(desktop: &Desktop) -> bool {
    let result = desktop
        .paths
        .node_command("desktop-setup.ts", &desktop.token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match result {
        Ok(child) => child,
        Err(error) => {
            desktop
                .log
                .write("desktop.log", &format!("desktop-setup: {error}"));
            return false;
        }
    };
    let (tx, rx) = mpsc::channel();
    capture(
        child.stdout.take().unwrap(),
        "desktop.log",
        desktop.log.clone(),
        tx.clone(),
    );
    capture(
        child.stderr.take().unwrap(),
        "desktop.log",
        desktop.log.clone(),
        tx,
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last_setup = None;
    let mut exited = None;
    let mut closed = 0;
    let mut drain_until = deadline;
    loop {
        while let Ok(message) = rx.try_recv() {
            match message {
                Control::Signal(signal @ DesktopSignal::Setup { .. }) => last_setup = Some(signal),
                Control::OutputClosed => closed += 1,
                _ => (),
            }
        }
        if exited.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    exited = Some(status.success());
                    drain_until = Instant::now() + Duration::from_millis(250);
                }
                Ok(None) => (),
                Err(error) => {
                    desktop
                        .log
                        .write("desktop.log", &format!("desktop-setup wait: {error}"));
                    break;
                }
            }
        }
        if exited.is_some() && (closed == 2 || Instant::now() >= drain_until) {
            break;
        }
        if desktop.stopping.load(Ordering::SeqCst) || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    if exited.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        desktop
            .log
            .write("desktop.log", "desktop-setup cancelled or exceeded 60s");
    }
    if let Some(ref signal) = last_setup {
        desktop.log.write(
            "desktop.log",
            &format!("@@desktop {}", serde_json::to_string(signal).unwrap()),
        );
    } else {
        desktop.log.write(
            "desktop.log",
            "desktop-setup did not return a setup message",
        );
    }
    exited == Some(true) && matches!(last_setup, Some(DesktopSignal::Setup { ok: true, .. }))
}

fn handle_signal(app: &AppHandle, desktop: &Desktop, signal: DesktopSignal) {
    desktop
        .log
        .write("desktop.log", &format!("desktop message: {signal:?}"));
    match signal {
        DesktopSignal::Autostart { on } => {
            let on = on
                .or_else(|| read_settings(&desktop.paths.data)["desktop"]["autostart"].as_bool())
                .unwrap_or(true);
            apply_autostart(app, desktop, on);
        }
        DesktopSignal::Lang { lang } => {
            let settings = lang
                .map(|lang| serde_json::json!({"ui":{"lang":lang}}))
                .unwrap_or_else(|| read_settings(&desktop.paths.data));
            desktop.view.lock().unwrap().lang =
                Lang::detect(&settings, sys_locale::get_locale().as_deref());
            if let Err(error) = refresh_menu(app, desktop) {
                desktop.log.write("desktop.log", &format!("menu: {error}"));
            }
        }
        DesktopSignal::Setup { ok, .. } => {
            desktop.view.lock().unwrap().setup_failed = !ok;
            if let Err(error) = refresh_menu(app, desktop) {
                desktop.log.write("desktop.log", &format!("menu: {error}"));
            }
        }
    }
}

fn occupied(
    app: &AppHandle,
    desktop: &Desktop,
    services: &mut [Service],
    port: u16,
    shown: &mut HashSet<u16>,
) {
    stop_services(services, desktop);
    set_status(app, desktop, Status::Occupied(port));
    if shown.insert(port) {
        let lang = desktop.view.lock().unwrap().lang;
        app.dialog()
            .message(lang.port("occupied_detail", port))
            .title(lang.text("name"))
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCustom(lang.text("ok").into()))
            .show(|_| {});
    }
}

fn stop_herdr(desktop: &Desktop) {
    let result = desktop
        .paths
        .command(&desktop.paths.herdr, &desktop.token)
        .args(["server", "stop"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = result {
        let deadline = Instant::now() + Duration::from_secs(3);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let result = child.wait();
        desktop
            .log
            .write("desktop.log", &format!("herdr server stop: {result:?}"));
    } else {
        desktop
            .log
            .write("desktop.log", "could not run herdr server stop");
    }
}

pub fn start(
    app: AppHandle,
    desktop: Arc<Desktop>,
    receiver: Receiver<Control>,
    mut open_on_health: bool,
) {
    thread::spawn(move || {
        desktop.log.write("desktop.log", "App starting");
        cleanup_ttyd(&desktop.paths, &desktop.log, false);
        let lang = desktop.view.lock().unwrap().lang;
        match takeover::take_over(&app, &desktop.paths, lang, &desktop.log) {
            Ok(true) => (),
            Ok(false) => {
                mark_done(&desktop);
                app.exit(0);
                return;
            }
            Err(error) => {
                show_error(&app, &desktop, &format!("takeover: {error}"));
                mark_done(&desktop);
                app.exit(1);
                return;
            }
        }
        let setup_ok = run_setup(&desktop);
        desktop.view.lock().unwrap().setup_failed = !setup_ok;
        let autostart = read_settings(&desktop.paths.data)["desktop"]["autostart"]
            .as_bool()
            .unwrap_or(true);
        if !desktop.stopping.load(Ordering::SeqCst) {
            apply_autostart(&app, &desktop, autostart);
        }
        let mut services = [
            Service::new("main.ts", "steward.log", "steward.err.log"),
            Service::new("terminal-runner.ts", "terminal.log", "terminal.err.log"),
        ];
        let epoch = Instant::now();
        let mut blocked = false;
        let mut preflight = true;
        let mut shown = HashSet::new();
        let mut next_health = Instant::now();
        let mut last_healthy = Instant::now();
        while !desktop.stopping.load(Ordering::SeqCst) {
            while let Ok(message) = receiver.try_recv() {
                match message {
                    Control::Quit => {
                        desktop.stopping.store(true, Ordering::SeqCst);
                    }
                    Control::Restart => {
                        stop_services(&mut services, &desktop);
                        for service in &mut services {
                            service.reset();
                        }
                        blocked = false;
                        preflight = true;
                        next_health = Instant::now();
                        last_healthy = Instant::now();
                        set_status(&app, &desktop, Status::Starting);
                    }
                    Control::Autostart(on) => {
                        let before = desktop.view.lock().unwrap().autostart;
                        if apply_autostart(&app, &desktop, on) {
                            let body = serde_json::json!({"settings":{"desktop":{"autostart":on}}})
                                .to_string();
                            if !request(
                                desktop.paths.port,
                                "PUT",
                                "/api/settings",
                                Some(&desktop.token),
                                Some(&body),
                            )
                            .is_ok_and(|reply| reply.status == 200)
                            {
                                apply_autostart(&app, &desktop, before);
                                show_error(
                                    &app,
                                    &desktop,
                                    "could not persist desktop.autostart with App token",
                                );
                            }
                        }
                    }
                    Control::Signal(signal) => handle_signal(&app, &desktop, signal),
                    Control::OutputClosed => (),
                }
            }
            if desktop.stopping.load(Ordering::SeqCst) {
                break;
            }
            if preflight {
                preflight = false;
                let conflict = if health(desktop.paths.port) != Health::Absent {
                    Some(desktop.paths.port)
                } else if port_open(desktop.paths.terminal_port) {
                    Some(desktop.paths.terminal_port)
                } else {
                    None
                };
                if let Some(port) = conflict {
                    occupied(&app, &desktop, &mut services, port, &mut shown);
                    blocked = true;
                }
            }
            if !blocked {
                for service in &mut services {
                    service.poll(&desktop, epoch);
                    service.launch(&desktop, epoch);
                }
                if services.iter().any(|service| service.stopped) {
                    set_status(&app, &desktop, Status::Stopped);
                }
                if Instant::now() >= next_health {
                    next_health = Instant::now() + Duration::from_secs(5);
                    match health(desktop.paths.port) {
                        Health::Desktop => {
                            last_healthy = Instant::now();
                            if services
                                .iter()
                                .all(|service| service.child.is_some() && !service.stopped)
                            {
                                set_status(&app, &desktop, Status::Running);
                                if open_on_health {
                                    open_on_health = false;
                                    open_browser(&app, &desktop, "");
                                }
                            }
                            if let Err(error) = refresh_menu(&app, &desktop) {
                                desktop.log.write("desktop.log", &format!("menu: {error}"));
                            }
                        }
                        Health::Occupied => {
                            occupied(
                                &app,
                                &desktop,
                                &mut services,
                                desktop.paths.port,
                                &mut shown,
                            );
                            blocked = true;
                        }
                        Health::Absent => {
                            if !services.iter().any(|service| service.stopped) {
                                set_status(&app, &desktop, Status::Starting);
                            }
                            if services[0].child.is_some()
                                && services[0].started.elapsed() >= Duration::from_secs(15)
                                && last_healthy.elapsed() >= Duration::from_secs(15)
                            {
                                desktop.log.write(
                                    "desktop.log",
                                    "main health check timed out; restarting main service",
                                );
                                stop_services(&mut services[..1], &desktop);
                                services[0].failed(&desktop, epoch);
                                last_healthy = Instant::now();
                            }
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        if desktop.stop_terminals.load(Ordering::SeqCst) {
            stop_herdr(&desktop);
        }
        stop_services(&mut services, &desktop);
        desktop.log.write("desktop.log", "App services stopped");
        mark_done(&desktop);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_delays_are_capped_at_thirty_seconds() {
        let mut policy = RestartPolicy::default();
        let delays = (0..8)
            .map(|index| {
                policy
                    .failed(Duration::from_secs(index * 121))
                    .unwrap()
                    .as_secs()
            })
            .collect::<Vec<_>>();
        assert_eq!(delays, [1, 2, 5, 10, 30, 30, 30, 30]);
    }
    #[test]
    fn fifth_failure_within_two_minutes_opens_the_circuit() {
        let mut policy = RestartPolicy::default();
        for now in [0, 1, 3, 8] {
            assert!(policy.failed(Duration::from_secs(now)).is_some());
        }
        assert_eq!(policy.failed(Duration::from_secs(18)), None);
        let mut boundary = RestartPolicy::default();
        for now in [0, 30, 60, 90] {
            assert!(boundary.failed(Duration::from_secs(now)).is_some());
        }
        assert_eq!(boundary.failed(Duration::from_secs(120)), None);
        let mut expired = RestartPolicy::default();
        for now in [0, 1, 2, 3] {
            assert!(expired.failed(Duration::from_secs(now)).is_some());
        }
        assert!(expired.failed(Duration::from_secs(121)).is_some());
    }
    #[test]
    fn desktop_messages_require_the_prefix_and_valid_known_payloads() {
        assert_eq!(
            parse_signal(r#"@@desktop {"cmd":"autostart","on":false}"#),
            Some(DesktopSignal::Autostart { on: Some(false) })
        );
        assert_eq!(
            parse_signal(r#"@@desktop {"cmd":"lang","lang":"en"}"#),
            Some(DesktopSignal::Lang {
                lang: Some("en".into())
            })
        );
        assert_eq!(
            parse_signal(r#"@@desktop {"cmd":"setup","ok":true,"notes":["ready"]}"#),
            Some(DesktopSignal::Setup {
                ok: true,
                notes: vec!["ready".into()]
            })
        );
        for line in [
            "normal log",
            "@@desktop not-json",
            r#"{"cmd":"lang","lang":"en"}"#,
            r#"@@desktop {"cmd":"unknown"}"#,
            r#"@@desktop {"cmd":"setup"}"#,
            r#"@@desktop {"cmd":"autostart","on":"yes"}"#,
        ] {
            assert!(parse_signal(line).is_none(), "{line}");
        }
    }
}
