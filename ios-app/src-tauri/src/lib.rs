// 專案管家 iPhone app。
// 管家本身跑在你的電腦上;app 打開時先顯示內建的 dist/index.html(填管家網址、檢查連得上),
// 連得上就整個畫面切到管家的網頁,用起來跟 Safari 一樣,但有自己的圖示、全螢幕、不會被分頁洗掉。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "ios")]
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                ios::below_status_bar(&w);
            }
            #[cfg(not(target_os = "ios"))]
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("專案管家 app 啟動失敗");
}

#[cfg(target_os = "ios")]
mod ios {
    use objc2::{class, msg_send};
    use objc2::runtime::AnyObject;

    /// 網頁預設鋪滿整個畫面、頂端被狀態列(時間、電池)蓋住。
    /// 用 Auto Layout 把網頁上緣接在安全區域頂端,左右下照舊貼齊畫面(底部的 Home 指示條網頁自己會留空)。
    /// 轉向、動態島大小不同都會自動跟著調整。
    pub fn below_status_bar(w: &tauri::WebviewWindow) {
        let _ = w.with_webview(|wv| unsafe {
            let web = wv.inner() as *mut AnyObject;
            if web.is_null() {
                return;
            }
            let parent: *mut AnyObject = msg_send![web, superview];
            if parent.is_null() {
                return;
            }
            // 狀態列後面的底色跟著系統深淺色(預設是固定白色,深色模式很突兀)
            let bg: *mut AnyObject = msg_send![class!(UIColor), systemBackgroundColor];
            let _: () = msg_send![parent, setBackgroundColor: bg];
            let _: () = msg_send![web, setTranslatesAutoresizingMaskIntoConstraints: false];
            let guide: *mut AnyObject = msg_send![parent, safeAreaLayoutGuide];
            let pairs: [(*mut AnyObject, *mut AnyObject); 4] = [
                (msg_send![web, topAnchor], msg_send![guide, topAnchor]),
                (msg_send![web, bottomAnchor], msg_send![parent, bottomAnchor]),
                (msg_send![web, leadingAnchor], msg_send![parent, leadingAnchor]),
                (msg_send![web, trailingAnchor], msg_send![parent, trailingAnchor]),
            ];
            for (a, b) in pairs {
                let c: *mut AnyObject = msg_send![a, constraintEqualToAnchor: b];
                let _: () = msg_send![c, setActive: true];
            }
        });
    }
}
