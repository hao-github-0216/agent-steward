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
