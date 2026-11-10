use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Lang {
    ZhTw,
    En,
}

const ZH: &[(&str, &str)] = &[
    ("name", "專案管家"), ("running", "執行中"), ("starting", "啟動中"),
    ("stopped", "服務停止了"), ("occupied", "連接埠 {port} 被其他程式占用"),
    ("setup_failed", "設定沒有完成，看紀錄"),
    ("open", "打開專案管家"), ("terminal", "打開終端機"),
    ("remote", "遠端存取"), ("off", "關閉"), ("tailscale", "Tailscale"), ("lan", "區網"),
    ("restart", "重新啟動服務"), ("logs", "打開紀錄資料夾"),
    ("autostart", "登入時自動啟動"), ("updates", "檢查更新…"),
    ("about", "關於與第三方授權"), ("quit", "結束專案管家"),
    ("quit_all", "結束並關閉所有終端機"),
    ("takeover", "偵測到用安裝指令裝的專案管家正在背景執行。要改由 App 管理嗎？設定與資料都會保留；舊的背景服務會停用並移除，舊的程式檔先留著。"),
    ("takeover_accept", "改由 App 管理"), ("takeover_decline", "結束 App"),
    ("occupied_detail", "連接埠 {port} 被其他程式占用，App 沒有繼續重新啟動服務。請先關閉占用這個連接埠的程式，或在設定檔更換連接埠，再選「重新啟動服務」。"),
    ("ok", "知道了"), ("error", "無法完成操作，請查看紀錄。"),
    ("update_development", "這是開發版，不檢查更新。"),
    ("update_busy", "App 正在檢查或處理更新，請先完成目前的更新視窗。"),
    ("update_check_error", "連不上 GitHub，無法檢查 App 更新。請稍後再試。"),
    ("update_current", "已經是最新版 v{version}。"),
    ("update_available", "有新版 v{new}（目前 v{current}）。更新時背景服務會重新啟動，網頁終端機會斷線一次，herdr 裡的 agent 會繼續跑。"),
    ("update_windows_herdr", "有新版 v{new}。更新需要關閉 herdr，所有終端機和 agent 都會結束。要現在更新嗎？"),
    ("update_install", "更新"), ("update_later", "稍後"), ("update_notes", "看更新內容"),
    ("update_install_error", "無法下載、驗證或安裝 App 更新，請稍後再試。原本的 App 仍可使用；詳細原因請查看紀錄。"),
    ("herdr_updated", "App 已更新，herdr 換成新版，但背景裡的 herdr 還是舊版。要重新啟動 herdr 嗎？所有終端機和 agent 都會結束。"),
    ("herdr_restart", "重新啟動 herdr"), ("herdr_later", "先不要"),
];
const EN: &[(&str, &str)] = &[
    ("name", "Agent Steward"), ("running", "Running"), ("starting", "Starting"),
    ("stopped", "Services stopped"), ("occupied", "Port {port} is used by another program"),
    ("setup_failed", "Setup is incomplete; check the logs"),
    ("open", "Open Agent Steward"), ("terminal", "Open terminal"),
    ("remote", "Remote access"), ("off", "Off"), ("tailscale", "Tailscale"), ("lan", "LAN"),
    ("restart", "Restart services"), ("logs", "Open logs folder"),
    ("autostart", "Start at login"), ("updates", "Check for updates…"),
    ("about", "About and third-party licenses"), ("quit", "Quit Agent Steward"),
    ("quit_all", "Quit and close all terminals"),
    ("takeover", "An installation made with the install command was detected. Let the App manage Agent Steward instead? Your settings and data will be kept. The old background services will be disabled and removed, but the old program files will be left in place."),
    ("takeover_accept", "Let the App manage it"), ("takeover_decline", "Quit App"),
    ("occupied_detail", "Port {port} is used by another program. The App has stopped restarting its services. Close that program, or change the port in settings, then choose “Restart services”."),
    ("ok", "OK"), ("error", "The operation failed. Please check the logs."),
    ("update_development", "This is a development build. App updates are not configured."),
    ("update_busy", "The App is already checking or handling an update. Please finish the current update dialog first."),
    ("update_check_error", "Cannot connect to GitHub to check for App updates. Please try again later."),
    ("update_current", "You already have the latest version, v{version}."),
    ("update_available", "Version v{new} is available (current: v{current}). Updating restarts the background services and disconnects the web terminal once. Agents in herdr will keep running."),
    ("update_windows_herdr", "Version v{new} is available. Updating requires closing herdr. All terminals and agents will end. Update now?"),
    ("update_install", "Update"), ("update_later", "Later"), ("update_notes", "Release notes"),
    ("update_install_error", "Could not download, verify, or install the App update. Please try again later. You can keep using the current App; check the logs for details."),
    ("herdr_updated", "The App now includes a newer herdr, but the background herdr is still the old version. Restart herdr? All terminals and agents will end."),
    ("herdr_restart", "Restart herdr"), ("herdr_later", "Not now"),
];

impl Lang {
    pub fn detect(settings: &Value, locale: Option<&str>) -> Self {
        match settings["ui"]["lang"].as_str() {
            Some("zh-TW") => Self::ZhTw,
            Some("en") => Self::En,
            _ => {
                if locale
                    .unwrap_or("en")
                    .to_ascii_lowercase()
                    .starts_with("zh")
                {
                    Self::ZhTw
                } else {
                    Self::En
                }
            }
        }
    }
    pub fn text(self, key: &str) -> &'static str {
        let table = if self == Self::ZhTw { ZH } else { EN };
        table
            .iter()
            .find(|(name, _)| *name == key)
            .expect("known translation key")
            .1
    }
    pub fn port(self, key: &str, port: u16) -> String {
        self.text(key).replace("{port}", &port.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translations_have_identical_unique_keys() {
        let keys = |table: &[(&str, &str)]| {
            table
                .iter()
                .map(|(key, _)| key.to_string())
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(keys(ZH), keys(EN));
        assert_eq!(keys(ZH).len(), ZH.len());
        assert_eq!(keys(EN).len(), EN.len());
        assert!(ZH.iter().chain(EN).all(|(_, value)| !value.is_empty()));
    }
    #[test]
    fn explicit_language_precedes_system_locale() {
        assert_eq!(
            Lang::detect(
                &serde_json::json!({"ui":{"lang":"en"}}),
                Some("zh_TW.UTF-8")
            ),
            Lang::En
        );
        assert_eq!(
            Lang::detect(&serde_json::json!({"ui":{"lang":"zh-TW"}}), Some("en-US")),
            Lang::ZhTw
        );
        assert_eq!(Lang::detect(&Value::Null, Some("zh-HK")), Lang::ZhTw);
        assert_eq!(Lang::detect(&Value::Null, Some("fr-FR")), Lang::En);
    }
}
