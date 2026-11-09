#!/bin/sh
# 專案管家安裝／更新程式：macOS、Linux。
# curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh
# 用 --dry-run 先看計畫；無法互動時加 --yes。完整選項：sh install.sh --help。

main() {
set -eu
# ---- generated: begin (scripts/gen-install.mjs) ----
msg() {
	case "$L:$1" in
		'zh-TW:list_separator') printf '%s' '、' ;;
		'en:list_separator') printf '%s' ', ' ;;
		'zh-TW:warning_prefix') printf '%s' '注意：' ;;
		'en:warning_prefix') printf '%s' 'Warning: ' ;;
		'zh-TW:error_prefix') printf '%s' '錯誤：' ;;
		'en:error_prefix') printf '%s' 'Error: ' ;;
		'zh-TW:missing_value') printf '%s' '%s 後面要接一個值。' ;;
		'en:missing_value') printf '%s' '%s requires a value.' ;;
		'zh-TW:unknown_option') printf '%s' '不認得的參數：%s' ;;
		'en:unknown_option') printf '%s' 'Unknown option: %s' ;;
		'zh-TW:invalid_lang') printf '%s' '不支援的語言：%s。請用 zh-TW 或 en。' ;;
		'en:invalid_lang') printf '%s' 'Unsupported language: %s. Use zh-TW or en.' ;;
		'zh-TW:invalid_component') printf '%s' '不認得的元件：%s' ;;
		'en:invalid_component') printf '%s' 'Unknown component: %s' ;;
		'zh-TW:invalid_env') printf '%s' '%s 的值不對，請用 0 或 1。' ;;
		'en:invalid_env') printf '%s' 'Invalid value for %s. Use 0 or 1.' ;;
		'zh-TW:need_command') printf '%s' '需要 %s。' ;;
		'en:need_command') printf '%s' 'Required command: %s.' ;;
		'zh-TW:unsupported_os') printf '%s' '不支援的系統：%s（Windows 請用 install.ps1）。' ;;
		'en:unsupported_os') printf '%s' 'Unsupported system: %s. On Windows, use install.ps1.' ;;
		'zh-TW:unsupported_arch') printf '%s' '不支援的處理器：%s' ;;
		'en:unsupported_arch') printf '%s' 'Unsupported processor: %s' ;;
		'zh-TW:invalid_from') printf '%s' '找不到原始碼資料夾：%s' ;;
		'en:invalid_from') printf '%s' 'Source directory not found: %s' ;;
		'zh-TW:installer_help') printf '%s' '用法：sh install.sh [選項]
  --from DIR       從本機原始碼安裝
  --version TAG    安裝指定版本
  --yes, -y        不再詢問是否開始安裝
  --dry-run        只列出計畫，不做改動
  --without=a,b    不安裝指定元件（herdr、terminal、herdr-config、autostart、open、brew-node）
  --lang zh-TW|en  指定訊息語言
  --readd-herdr-key  把你之前拿掉的 herdr 資料夾導覽快捷鍵加回來
  --skip-herdr     等同 --without=herdr
  --no-service     等同 --without=autostart,open
  --no-open        等同 --without=open
範例：sh install.sh --from . --yes --without=autostart,open' ;;
		'en:installer_help') printf '%s' 'Usage: sh install.sh [options]
  --from DIR       Install local source
  --version TAG    Install a specific version
  --yes, -y        Skip installation confirmation
  --dry-run        Show the plan without making changes
  --without=a,b    Omit components (herdr, terminal, herdr-config, autostart, open, brew-node)
  --lang zh-TW|en  Set the message language
  --readd-herdr-key  Restore the herdr folder-navigation shortcut you removed
  --skip-herdr     Same as --without=herdr
  --no-service     Same as --without=autostart,open
  --no-open        Same as --without=open
Example: sh install.sh --from . --yes --without=autostart,open' ;;
		'zh-TW:plan_title') printf '%s' '專案管家 %s 安裝程式 — 看完再決定要不要裝' ;;
		'en:plan_title') printf '%s' 'agent-steward %s installer — review before installing' ;;
		'zh-TW:plan_update_title') printf '%s' '專案管家 %s → %s' ;;
		'en:plan_update_title') printf '%s' 'agent-steward %s → %s' ;;
		'zh-TW:plan_downloads') printf '%s' '會下載：' ;;
		'en:plan_downloads') printf '%s' 'Downloads:' ;;
		'zh-TW:plan_app') printf '%s' '  專案管家 %s + 相依套件   %s + %s   github.com/hao-github-0216、registry.npmjs.org（MIT）' ;;
		'en:plan_app') printf '%s' '  agent-steward %s + dependencies   %s + %s   github.com/hao-github-0216, registry.npmjs.org (MIT)' ;;
		'zh-TW:plan_local') printf '%s' '  程式來自本機原始碼：%s（%s）' ;;
		'en:plan_local') printf '%s' '  App source: %s (%s)' ;;
		'zh-TW:plan_node') printf '%s' '  Node.js %s   %s   nodejs.org（MIT）' ;;
		'en:plan_node') printf '%s' '  Node.js %s   %s   nodejs.org (MIT)' ;;
		'zh-TW:plan_existing') printf '%s' '  %s：已有，沿用：%s' ;;
		'en:plan_existing') printf '%s' '  %s: already installed, reuse: %s' ;;
		'zh-TW:plan_node_brew') printf '%s' '  Node.js：會執行 brew install node（Homebrew）' ;;
		'en:plan_node_brew') printf '%s' '  Node.js: run brew install node (Homebrew)' ;;
		'zh-TW:plan_herdr') printf '%s' '  herdr %s   %s   github.com/hao-github-0216/herdr（Apache-2.0，修改版）' ;;
		'en:plan_herdr') printf '%s' '  herdr %s   %s   github.com/hao-github-0216/herdr (Apache-2.0, modified build)' ;;
		'zh-TW:plan_herdr_current') printf '%s' '  herdr：已是 %s，不下載' ;;
		'en:plan_herdr_current') printf '%s' '  herdr: already at %s, no download' ;;
		'zh-TW:plan_ttyd') printf '%s' '  ttyd（網頁終端機）   %s   github.com/tsl0922/ttyd（MIT）' ;;
		'en:plan_ttyd') printf '%s' '  ttyd (web terminal)   %s   github.com/tsl0922/ttyd (MIT)' ;;
		'zh-TW:plan_ttyd_brew') printf '%s' '  macOS：會執行 brew install ttyd（Homebrew）' ;;
		'en:plan_ttyd_brew') printf '%s' '  macOS: run brew install ttyd (Homebrew)' ;;
		'zh-TW:plan_ttyd_no_brew') printf '%s' '  macOS：ttyd 需要 Homebrew；沒有 Homebrew 時先略過，不會自動安裝 Homebrew。' ;;
		'en:plan_ttyd_no_brew') printf '%s' '  macOS: ttyd requires Homebrew; skip it if Homebrew is unavailable. Homebrew will not be installed.' ;;
		'zh-TW:plan_places') printf '%s' '會放東西的地方：' ;;
		'en:plan_places') printf '%s' 'Install locations:' ;;
		'zh-TW:plan_root') printf '%s' '  %s/   程式、Node、設定與資料' ;;
		'en:plan_root') printf '%s' '  %s/   App, Node, settings, and data' ;;
		'zh-TW:plan_steward') printf '%s' '  %s   steward 指令' ;;
		'en:plan_steward') printf '%s' '  %s   steward command' ;;
		'zh-TW:plan_herdr_link') printf '%s' '  %s   herdr 指令（已經有就不動）' ;;
		'en:plan_herdr_link') printf '%s' '  %s   herdr command (leave existing commands untouched)' ;;
		'zh-TW:plan_plugins') printf '%s' '  %s/   兩個 herdr 外掛' ;;
		'en:plan_plugins') printf '%s' '  %s/   Two herdr plugins' ;;
		'zh-TW:plan_config_header') printf '%s' '會修改其他程式的設定（先備份成 .bak-steward-日期）：' ;;
		'en:plan_config_header') printf '%s' 'Other settings to change (backed up as .bak-steward-date first):' ;;
		'zh-TW:plan_config') printf '%s' '  %s   加上或更新資料夾導覽快捷鍵 prefix+e（你自己拿掉的不會加回來）' ;;
		'en:plan_config') printf '%s' '  %s   Add or update the prefix+e folder shortcut (do not restore shortcuts you removed)' ;;
		'zh-TW:plan_autostart') printf '%s' '登入時自動在背景執行（掛掉會自動重開）：' ;;
		'en:plan_autostart') printf '%s' 'Run in the background at login (restart on failure):' ;;
		'zh-TW:plan_launchd') printf '%s' '  macOS：LaunchAgent %s（會出現在「系統設定 → 一般 → 登入項目」）' ;;
		'en:plan_launchd') printf '%s' '  macOS: LaunchAgent %s (shown in System Settings → General → Login Items)' ;;
		'zh-TW:plan_systemd') printf '%s' '  Linux：systemd --user 的 %s，並開啟 linger' ;;
		'en:plan_systemd') printf '%s' '  Linux: systemd --user units %s, with linger enabled' ;;
		'zh-TW:plan_network') printf '%s' '網路：只聽 127.0.0.1:%s（網頁），不開放給區網或 Tailscale。' ;;
		'en:plan_network') printf '%s' 'Network: listen only on 127.0.0.1:%s (web), not on LAN or Tailscale.' ;;
		'zh-TW:plan_network_terminal') printf '%s' '      終端機只聽 127.0.0.1:%s。' ;;
		'en:plan_network_terminal') printf '%s' '         The terminal listens only on 127.0.0.1:%s.' ;;
		'zh-TW:plan_access') printf '%s' '      要從手機連，裝完到「設定 → 存取」自己打開。' ;;
		'en:plan_access') printf '%s' '         To connect from a phone, enable access in Settings → Access after installing.' ;;
		'zh-TW:plan_wont') printf '%s' '不會做：不改 AI agent 的設定（之後在「設定 → Agent」自己選）、不傳送任何使用資料、不需要 sudo。' ;;
		'en:plan_wont') printf '%s' 'Will not change AI agent settings (choose integrations later in Settings → Agent), send usage data, or require sudo.' ;;
		'zh-TW:plan_remove') printf '%s' '移除：sh %s/uninstall.sh' ;;
		'en:plan_remove') printf '%s' 'Uninstall: sh %s/uninstall.sh' ;;
		'zh-TW:plan_without') printf '%s' '這次不裝：%s' ;;
		'en:plan_without') printf '%s' 'Omitted this time: %s' ;;
		'zh-TW:update_downloads') printf '%s' '會下載：專案管家和相依套件（%s + %s）%s' ;;
		'en:update_downloads') printf '%s' 'Downloads: agent-steward and dependencies (%s + %s)%s' ;;
		'zh-TW:update_herdr') printf '%s' '、herdr %s' ;;
		'en:update_herdr') printf '%s' ', herdr %s' ;;
		'zh-TW:update_restart') printf '%s' '背景服務會重新啟動（開著的網頁終端機會斷線一次）。' ;;
		'en:update_restart') printf '%s' 'Background services will restart (open web terminals will disconnect once).' ;;
		'zh-TW:update_keep') printf '%s' '沿用你上次的選擇，你自己拿掉的設定不會加回來。' ;;
		'en:update_keep') printf '%s' 'Keep your previous choices. Settings you removed will not be added back.' ;;
		'zh-TW:update_choices') printf '%s' '使用這次的選擇，你自己拿掉的設定不會加回來。' ;;
		'en:update_choices') printf '%s' 'Use the choices shown here. Settings you removed will not be added back.' ;;
		'zh-TW:no_tty') printf '%s' '沒有可互動的終端機，尚未做任何改動。請加 --yes，例如：curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh -s -- --yes' ;;
		'en:no_tty') printf '%s' 'No interactive terminal; nothing has changed. Add --yes, for example: curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh -s -- --yes' ;;
		'zh-TW:install_choices') printf '%s' '  1) 開始安裝   2) 自訂   3) 取消' ;;
		'en:install_choices') printf '%s' '  1) Install   2) Customize   3) Cancel' ;;
		'zh-TW:install_prompt') printf '%s' '請選擇 [1]：' ;;
		'en:install_prompt') printf '%s' 'Choose [1]: ' ;;
		'zh-TW:update_prompt') printf '%s' '繼續？[Y] 是  [n] 取消  [c] 自訂：' ;;
		'en:update_prompt') printf '%s' 'Continue? [Y] yes  [n] cancel  [c] customize: ' ;;
		'zh-TW:cancelled') printf '%s' '已取消，沒有做任何改動。' ;;
		'en:cancelled') printf '%s' 'Cancelled. Nothing has changed.' ;;
		'zh-TW:invalid_answer') printf '%s' '請輸入選單上的選項。' ;;
		'en:invalid_answer') printf '%s' 'Enter one of the menu options.' ;;
		'zh-TW:custom_title') printf '%s' '自訂安裝（輸入編號切換，按 Enter 回到計畫）：' ;;
		'en:custom_title') printf '%s' 'Customize (enter a number to toggle; Enter returns to the plan):' ;;
		'zh-TW:custom_item') printf '%s' '  [%s] %s %s — %s' ;;
		'en:custom_item') printf '%s' '  [%s] %s %s — %s' ;;
		'zh-TW:custom_prompt') printf '%s' '請輸入編號：' ;;
		'en:custom_prompt') printf '%s' 'Number: ' ;;
		'zh-TW:component_herdr') printf '%s' 'herdr' ;;
		'en:component_herdr') printf '%s' 'herdr' ;;
		'zh-TW:component_terminal') printf '%s' '網頁終端機' ;;
		'en:component_terminal') printf '%s' 'Web terminal' ;;
		'zh-TW:component_herdr_config') printf '%s' 'herdr 快捷鍵與外掛' ;;
		'en:component_herdr_config') printf '%s' 'herdr shortcuts and plugins' ;;
		'zh-TW:component_autostart') printf '%s' '登入時自動啟動' ;;
		'en:component_autostart') printf '%s' 'Start at login' ;;
		'zh-TW:component_open') printf '%s' '裝完打開瀏覽器' ;;
		'en:component_open') printf '%s' 'Open the browser after installing' ;;
		'zh-TW:component_brew_node') printf '%s' '用 Homebrew 安裝 Node.js' ;;
		'en:component_brew_node') printf '%s' 'Install Node.js with Homebrew' ;;
		'zh-TW:consequence_herdr') printf '%s' '關掉後，終端機、自動記錄、派工都不能用；也會關掉網頁終端機和 herdr 快捷鍵與外掛。' ;;
		'en:consequence_herdr') printf '%s' 'Without it, terminals, automatic recording, and dispatch are unavailable; also disables the web terminal and herdr configuration.' ;;
		'zh-TW:consequence_terminal') printf '%s' '關掉後，網頁上不能開終端機。' ;;
		'en:consequence_terminal') printf '%s' 'Without it, web terminals are unavailable.' ;;
		'zh-TW:consequence_herdr_config') printf '%s' '關掉後，沒有資料夾導覽 popup，agents 清單不會只顯示目前 space。' ;;
		'en:consequence_herdr_config') printf '%s' 'Without it, no folder navigation popup and no agents list filtered to the current space.' ;;
		'zh-TW:consequence_autostart') printf '%s' '關掉後，要自己執行才會跑。' ;;
		'en:consequence_autostart') printf '%s' 'Without it, start the app manually.' ;;
		'zh-TW:consequence_open') printf '%s' '關掉後，裝完不打開瀏覽器。' ;;
		'en:consequence_open') printf '%s' 'Without it, the browser stays closed.' ;;
		'zh-TW:consequence_brew_node') printf '%s' '預設關閉；關掉時下載 Node.js 到 ~/.agent-steward/node，不會用 brew 安裝。' ;;
		'en:consequence_brew_node') printf '%s' 'Off by default. When off, download Node.js to ~/.agent-steward/node instead of using brew.' ;;
		'zh-TW:herdr_disabled') printf '%s' '已一起關掉網頁終端機和 herdr 快捷鍵與外掛。' ;;
		'en:herdr_disabled') printf '%s' 'Also disabled the web terminal and herdr configuration.' ;;
		'zh-TW:node_brew') printf '%s' '安裝 Node.js（Homebrew）' ;;
		'en:node_brew') printf '%s' 'Installing Node.js (Homebrew)' ;;
		'zh-TW:node_download') printf '%s' '下載 Node.js（放在 %s/node，不需要管理員權限）' ;;
		'en:node_download') printf '%s' 'Downloading Node.js (to %s/node, no administrator privileges needed)' ;;
		'zh-TW:node_connect_failed') printf '%s' '連不上 nodejs.org。' ;;
		'en:node_connect_failed') printf '%s' 'Cannot connect to nodejs.org.' ;;
		'zh-TW:node_file_missing') printf '%s' '找不到 Node.js 下載檔。' ;;
		'en:node_file_missing') printf '%s' 'Node.js download not found.' ;;
		'zh-TW:node_checksum_failed') printf '%s' 'Node.js 檔案驗證失敗（sha256 不符）。' ;;
		'en:node_checksum_failed') printf '%s' 'Node.js verification failed (sha256 mismatch).' ;;
		'zh-TW:npm_missing') printf '%s' '找不到 npm。' ;;
		'en:npm_missing') printf '%s' 'npm not found.' ;;
		'zh-TW:node_ready') printf '%s' 'Node.js %s（%s）' ;;
		'en:node_ready') printf '%s' 'Node.js %s (%s)' ;;
		'zh-TW:app_from_git') printf '%s' '從本機原始碼安裝（%s 目前的 commit）' ;;
		'en:app_from_git') printf '%s' 'Installing the current commit from local source (%s)' ;;
		'zh-TW:app_from_dir') printf '%s' '從本機資料夾安裝（%s）' ;;
		'en:app_from_dir') printf '%s' 'Installing from a local directory (%s)' ;;
		'zh-TW:app_download') printf '%s' '下載專案管家 %s' ;;
		'en:app_download') printf '%s' 'Downloading agent-steward %s' ;;
		'zh-TW:download_failed') printf '%s' '下載失敗：%s' ;;
		'en:download_failed') printf '%s' 'Download failed: %s' ;;
		'zh-TW:deps_install') printf '%s' '安裝相依套件' ;;
		'en:deps_install') printf '%s' 'Installing dependencies' ;;
		'zh-TW:deps_failed') printf '%s' '安裝相依套件失敗。' ;;
		'en:deps_failed') printf '%s' 'Dependency installation failed.' ;;
		'zh-TW:app_installed') printf '%s' '已安裝到 %s（%s）' ;;
		'en:app_installed') printf '%s' 'Installed to %s (%s)' ;;
		'zh-TW:herdr_download') printf '%s' '下載 herdr %s（%s）' ;;
		'en:herdr_download') printf '%s' 'Downloading herdr %s (%s)' ;;
		'zh-TW:herdr_checksum_failed') printf '%s' 'herdr 檔案驗證失敗（sha256 不符）。' ;;
		'en:herdr_checksum_failed') printf '%s' 'herdr verification failed (sha256 mismatch).' ;;
		'zh-TW:herdr_download_failed') printf '%s' '下載 herdr 失敗：終端機、自動記錄、派工會先無法使用，之後再跑一次安裝即可。' ;;
		'en:herdr_download_failed') printf '%s' 'herdr download failed. Terminals, automatic recording, and dispatch are unavailable until you rerun the installer.' ;;
		'zh-TW:ttyd_brew') printf '%s' '安裝 ttyd（Homebrew）' ;;
		'en:ttyd_brew') printf '%s' 'Installing ttyd (Homebrew)' ;;
		'zh-TW:ttyd_download') printf '%s' '下載 ttyd' ;;
		'en:ttyd_download') printf '%s' 'Downloading ttyd' ;;
		'zh-TW:ttyd_missing') printf '%s' '沒有 ttyd：網頁終端機先無法使用，其他功能照常。裝完最後會說明怎麼補上。' ;;
		'en:ttyd_missing') printf '%s' 'ttyd is unavailable. Other features still work; instructions for adding the web terminal follow below.' ;;
		'zh-TW:path_missing') printf '%s' '%s 不在 PATH 裡。要用 steward 指令，請把它加進 shell 設定，例如 ~/.zshrc。' ;;
		'en:path_missing') printf '%s' '%s is not in PATH. Add it to your shell configuration (for example, ~/.zshrc) to use steward.' ;;
		'zh-TW:plugin_link_failed') printf '%s' 'herdr 外掛 %s 沒有接上。herdr 可能還沒啟動過，之後再跑一次安裝即可。' ;;
		'en:plugin_link_failed') printf '%s' 'Could not link herdr plugin %s. If herdr has not started yet, rerun the installer later.' ;;
		'zh-TW:herdr_setup_failed') printf '%s' '設定 herdr 的資料夾導覽失敗。' ;;
		'en:herdr_setup_failed') printf '%s' 'Could not configure herdr folder navigation.' ;;
		'zh-TW:agents_refresh_failed') printf '%s' '更新 agent 整合失敗。' ;;
		'en:agents_refresh_failed') printf '%s' 'Could not refresh agent integrations.' ;;
		'zh-TW:ttyd_note_macos') printf '%s' '網頁終端機需要 ttyd，而 macOS 上的 ttyd 要用 Homebrew 安裝。要用網頁終端機的話：' ;;
		'en:ttyd_note_macos') printf '%s' 'The web terminal requires ttyd. On macOS, install it with Homebrew:' ;;
		'zh-TW:ttyd_note_brew') printf '%s' '    1. 安裝 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' ;;
		'en:ttyd_note_brew') printf '%s' '    1. Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' ;;
		'zh-TW:ttyd_note_rerun') printf '%s' '    2. 再跑一次專案管家的安裝指令，會自動裝好 ttyd。' ;;
		'en:ttyd_note_rerun') printf '%s' '    2. Rerun the agent-steward installer to install ttyd.' ;;
		'zh-TW:ttyd_note_linux') printf '%s' '網頁終端機需要 ttyd，但下載失敗了。再跑一次安裝指令即可補上。' ;;
		'en:ttyd_note_linux') printf '%s' 'The ttyd download failed. Rerun the installer to add the web terminal.' ;;
		'zh-TW:service_skipped') printf '%s' '略過登入時自動啟動。' ;;
		'en:service_skipped') printf '%s' 'Skipping start at login.' ;;
		'zh-TW:service_old_removed') printf '%s' '移除舊的服務 %s' ;;
		'en:service_old_removed') printf '%s' 'Removed old service %s' ;;
		'zh-TW:service_failed') printf '%s' '專案管家沒有啟動起來，請看 %s/logs/steward.err.log。' ;;
		'en:service_failed') printf '%s' 'agent-steward did not start. See %s/logs/steward.err.log.' ;;
		'zh-TW:linger_failed') printf '%s' '沒有開啟 linger，登出後背景服務可能停止。' ;;
		'en:linger_failed') printf '%s' 'Could not enable linger; background services may stop after logout.' ;;
		'zh-TW:summary_done') printf '%s' '專案管家 %s 已經裝好。' ;;
		'en:summary_done') printf '%s' 'agent-steward %s is installed.' ;;
		'zh-TW:summary_web') printf '%s' '  網頁：http://127.0.0.1:%s/（只有這台電腦連得到）' ;;
		'en:summary_web') printf '%s' '  Web: http://127.0.0.1:%s/ (only reachable from this computer)' ;;
		'zh-TW:summary_service') printf '%s' '  背景服務：%s；停止：%s' ;;
		'en:summary_service') printf '%s' '  Background service: %s; stop with: %s' ;;
		'zh-TW:summary_manual') printf '%s' '  手動啟動：cd "%s" && "%s" --experimental-strip-types --no-warnings src/main.ts' ;;
		'en:summary_manual') printf '%s' '  Start manually: cd "%s" && "%s" --experimental-strip-types --no-warnings src/main.ts' ;;
		'zh-TW:summary_receipt') printf '%s' '  這次的改動記在 %s/install.json' ;;
		'en:summary_receipt') printf '%s' '  Changes are recorded in %s/install.json' ;;
		'zh-TW:summary_remove') printf '%s' '  移除：sh %s/uninstall.sh' ;;
		'en:summary_remove') printf '%s' '  Uninstall: sh %s/uninstall.sh' ;;
		'zh-TW:summary_privacy') printf '%s' '  專案管家不會傳送任何使用資料。' ;;
		'en:summary_privacy') printf '%s' '  agent-steward does not send usage data.' ;;
		'zh-TW:first_use') printf '%s' '第一次使用：在瀏覽器裡設定管理密碼、AI 接口和要接上的 agent。' ;;
		'en:first_use') printf '%s' 'On first use, configure an admin password, AI providers, and agent integrations in your browser.' ;;
		'zh-TW:uninstall_agents') printf '%s' '拿掉各 agent 的專案管家整合' ;;
		'en:uninstall_agents') printf '%s' 'Removing agent-steward integrations' ;;
		'zh-TW:uninstall_stopped') printf '%s' '已停止服務' ;;
		'en:uninstall_stopped') printf '%s' 'Services stopped' ;;
		'zh-TW:uninstall_linger') printf '%s' '已關閉安裝程式開啟的 linger。' ;;
		'en:uninstall_linger') printf '%s' 'Disabled linger that was enabled by the installer.' ;;
		'zh-TW:uninstall_backups') printf '%s' '這些備份檔留著，要刪可以自己刪：' ;;
		'en:uninstall_backups') printf '%s' 'These backups were kept. You can delete them yourself:' ;;
		'zh-TW:uninstall_purged') printf '%s' '已刪除 %s（含所有資料）' ;;
		'en:uninstall_purged') printf '%s' 'Deleted %s, including all data' ;;
		'zh-TW:uninstall_kept') printf '%s' '已移除程式；資料留在 %s。要全部刪掉：rm -rf %s' ;;
		'en:uninstall_kept') printf '%s' 'App removed; data remains in %s. To delete everything: rm -rf %s' ;;
		'zh-TW:herdr_key_removed') printf '%s' '你自己拿掉了 herdr 的資料夾導覽快捷鍵，這次不加回去。要加回來：再跑一次安裝並加上 --readd-herdr-key。' ;;
		'en:herdr_key_removed') printf '%s' 'You removed the herdr folder-navigation shortcut, so it was not added back. To restore it, run the installer again with --readd-herdr-key.' ;;
		'zh-TW:herdr_folder_description') printf '%s' '資料夾導覽' ;;
		'en:herdr_folder_description') printf '%s' 'Folder navigation' ;;
		'zh-TW:herdr_config_removed') printf '%s' 'herdr 設定：已拿掉資料夾導覽' ;;
		'en:herdr_config_removed') printf '%s' 'herdr configuration: removed folder navigation' ;;
		'zh-TW:herdr_config_absent') printf '%s' 'herdr 設定：沒有資料夾導覽' ;;
		'en:herdr_config_absent') printf '%s' 'herdr configuration: no folder navigation' ;;
		'zh-TW:herdr_config_updated') printf '%s' 'herdr 設定：已加上或更新資料夾導覽（%s）' ;;
		'en:herdr_config_updated') printf '%s' 'herdr configuration: added or updated folder navigation (%s)' ;;
		'zh-TW:herdr_config_current') printf '%s' 'herdr 設定：資料夾導覽已經是最新的' ;;
		'en:herdr_config_current') printf '%s' 'herdr configuration: folder navigation is up to date' ;;
		'zh-TW:receipt_header') printf '%s' '安裝程式做過的改動（記在 install.json）：' ;;
		'en:receipt_header') printf '%s' 'Changes made by the installer (recorded in install.json):' ;;
		'zh-TW:uninstall_receipt_header') printf '%s' '安裝時做過的改動（已移除）：' ;;
		'en:uninstall_receipt_header') printf '%s' 'Changes made at install time (now removed):' ;;
		'zh-TW:receipt_change_file') printf '%s' '  檔案：%s%s' ;;
		'en:receipt_change_file') printf '%s' '  File: %s%s' ;;
		'zh-TW:receipt_change_modified') printf '%s' '  修改設定：%s%s' ;;
		'en:receipt_change_modified') printf '%s' '  Modified settings: %s%s' ;;
		'zh-TW:receipt_change_symlink') printf '%s' '  連結：%s%s' ;;
		'en:receipt_change_symlink') printf '%s' '  Symlink: %s%s' ;;
		'zh-TW:receipt_change_launchd') printf '%s' '  LaunchAgent：%s%s' ;;
		'en:receipt_change_launchd') printf '%s' '  LaunchAgent: %s%s' ;;
		'zh-TW:receipt_change_systemd') printf '%s' '  systemd 服務：%s%s' ;;
		'en:receipt_change_systemd') printf '%s' '  systemd unit: %s%s' ;;
		'zh-TW:receipt_change_linger') printf '%s' '  linger：%s%s' ;;
		'en:receipt_change_linger') printf '%s' '  Linger: %s%s' ;;
		'zh-TW:receipt_change_herdr-plugin') printf '%s' '  herdr 外掛：%s%s' ;;
		'en:receipt_change_herdr-plugin') printf '%s' '  herdr plugin: %s%s' ;;
		'zh-TW:receipt_backup') printf '%s' '  備份：%s' ;;
		'en:receipt_backup') printf '%s' '  Backup: %s' ;;
		'zh-TW:receipt_error') printf '%s' '收據錯誤：%s' ;;
		'en:receipt_error') printf '%s' 'Receipt error: %s' ;;
		'zh-TW:receipt_usage') printf '%s' '用法：install-receipt.ts set '\''<json>'\'' | change <type> <path> [note] | backup <path> | get <key> | summary <lang> [header-key]' ;;
		'en:receipt_usage') printf '%s' 'Usage: install-receipt.ts set '\''<json>'\'' | change <type> <path> [note] | backup <path> | get <key> | summary <lang> [header-key]' ;;
		*) printf '%s' "$1" ;;
	esac
}
t() { _key=$1; shift; printf "$(msg "$_key")" "$@"; }
tl() { t "$@"; printf '\n'; }
APP_LICENSE='MIT'
APP_HOME='https://github.com/hao-github-0216/agent-steward'
NODE_VERSION='22'
NODE_LICENSE='MIT'
NODE_HOME='https://nodejs.org'
NODE_SOURCE='https://nodejs.org/dist/latest-v22.x/'
HERDR_REPO='hao-github-0216/herdr'
HERDR_TAG='steward-v0.9.5-1'
HERDR_LICENSE='Apache-2.0'
HERDR_HOME='https://github.com/hao-github-0216/herdr'
TTYD_LICENSE='MIT'
TTYD_HOME='https://github.com/tsl0922/ttyd'
TTYD_SOURCE_LINUX='https://github.com/tsl0922/ttyd/releases/latest/download/'
TTYD_SOURCE_MACOS='brew'
component_data() {
	case "$L" in
		'zh-TW')
			APP_NAME='專案管家'
			SIZE_APP='約 2 MB'
			SIZE_APP_DEPS='約 110 MB'
			NODE_NAME='Node.js'
			SIZE_NODE='約 45 MB'
			HERDR_NAME='herdr'
			HERDR_NOTE='專案管家用的 herdr 版本(上游 v0.9.5 加上資料夾導覽等修改)。安裝程式從這個 release 下載。'
			SIZE_HERDR='約 10 MB'
			TTYD_NAME='ttyd（網頁終端機）'
			SIZE_TTYD='約 2 MB'
			;;
		'en')
			APP_NAME='agent-steward'
			SIZE_APP='~2 MB'
			SIZE_APP_DEPS='~110 MB'
			NODE_NAME='Node.js'
			SIZE_NODE='~45 MB'
			HERDR_NAME='herdr'
			HERDR_NOTE='The herdr build for agent-steward (upstream v0.9.5 with folder navigation and other changes). The installer downloads this release.'
			SIZE_HERDR='~10 MB'
			TTYD_NAME='ttyd (web terminal)'
			SIZE_TTYD='~2 MB'
			;;
	esac
}
# ---- generated: end ----

REPO="${STEWARD_REPO:-hao-github-0216/agent-steward}"
ROOT="$HOME/.agent-steward"
APP="$ROOT/app"
BINDIR="$ROOT/bin"
LOCALBIN="$HOME/.local/bin"
PLUG="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins-local"
tilde() { case "$1" in "$HOME"|"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
FROM=""; VERSION=""; LANG_ARG="${STEWARD_LANG:-}"
YES="${STEWARD_YES:-0}"; DRY_RUN="${STEWARD_DRY_RUN:-0}"
READD="${STEWARD_READD_HERDR_KEY:-0}"
WITHOUT_INPUT="${STEWARD_WITHOUT:-}"; WITHOUT_EXPLICIT=0
[ -z "$WITHOUT_INPUT" ] || WITHOUT_EXPLICIT=1
ARG_ERROR=""; ARG_VALUE=""; HELP=0
arg_error() { if [ -z "$ARG_ERROR" ]; then ARG_ERROR=$1; ARG_VALUE=$2; fi; }
while [ $# -gt 0 ]; do
	case "$1" in
		--from|--version|--without|--lang)
			opt=$1
			if [ $# -lt 2 ]; then arg_error missing_value "$opt"; shift; continue; fi
			case "$2" in --*) arg_error missing_value "$opt"; shift; continue ;; esac
			case "$opt" in
				--from) FROM=$2 ;; --version) VERSION=$2 ;; --lang) LANG_ARG=$2 ;;
				--without) WITHOUT_INPUT="${WITHOUT_INPUT:+$WITHOUT_INPUT,}$2"; WITHOUT_EXPLICIT=1 ;;
			esac
			shift 2 ;;
		--lang=*) LANG_ARG=${1#*=}; [ -n "$LANG_ARG" ] || arg_error missing_value --lang; shift ;;
		--without=*) WITHOUT_INPUT="${WITHOUT_INPUT:+$WITHOUT_INPUT,}${1#*=}"; WITHOUT_EXPLICIT=1; shift ;;
		--yes|-y) YES=1; shift ;;
		--dry-run) DRY_RUN=1; shift ;;
		--readd-herdr-key) READD=1; shift ;;
		--skip-herdr) WITHOUT_INPUT="${WITHOUT_INPUT:+$WITHOUT_INPUT,}herdr"; WITHOUT_EXPLICIT=1; shift ;;
		--no-service) WITHOUT_INPUT="${WITHOUT_INPUT:+$WITHOUT_INPUT,}autostart,open"; WITHOUT_EXPLICIT=1; shift ;;
		--no-open) WITHOUT_INPUT="${WITHOUT_INPUT:+$WITHOUT_INPUT,}open"; WITHOUT_EXPLICIT=1; shift ;;
		--update) shift ;;
		--help|-h) HELP=1; shift ;;
		*) arg_error unknown_option "$1"; shift ;;
	esac
done

# 語言偵測只讀設定；此時尚未建立任何目錄。
normalize_lang() { case "$1" in zh|zh-*|zh_*|ZH|ZH-*|ZH_*) printf '%s' zh-TW ;; en) printf '%s' en ;; *) return 1 ;; esac; }
read_string() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -1; }
SAVED_LANG=$(sed -n '/"ui"[[:space:]]*:[[:space:]]*{/,/}/s/.*"lang"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/settings.json" 2>/dev/null | head -1 || true)
SAVED_LANG=$(normalize_lang "$SAVED_LANG" || true)
if [ -z "$SAVED_LANG" ]; then SAVED_LANG=$(normalize_lang "$(read_string "$ROOT/install.json" lang || true)" || true); fi
if [ -z "$SAVED_LANG" ] && [ -f "$APP/REVISION" ] && [ ! -f "$ROOT/install.json" ]; then SAVED_LANG=zh-TW; fi
L=$SAVED_LANG
if [ -z "$L" ]; then
	for locale in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
		case "$locale" in ''|C|POSIX|C.UTF-8) continue ;; zh*) L=zh-TW ;; *) L=en ;; esac
		break
	done
fi
if [ -z "$L" ] && [ "$(uname -s)" = Darwin ]; then
	apple_lang=$(defaults read -g AppleLanguages 2>/dev/null | tr -d '()"[:space:]' || true)
	case "$apple_lang" in zh*) L=zh-TW ;; esac
fi
L=${L:-en}
say() { printf '\033[1m==>\033[0m '; tl "$@"; }
warn() { { printf '\033[33m'; t warning_prefix; printf '\033[0m'; tl "$@"; } >&2; }
die() { { printf '\033[31m'; t error_prefix; printf '\033[0m'; tl "$@"; } >&2; exit 1; }
if [ -n "$LANG_ARG" ]; then
	chosen_lang=$(normalize_lang "$LANG_ARG" || true)
	[ -n "$chosen_lang" ] || die invalid_lang "$LANG_ARG"
	L=$chosen_lang
fi
if [ -n "$ARG_ERROR" ]; then tl "$ARG_ERROR" "$ARG_VALUE" >&2; exit 2; fi
case "$YES" in 0|1) ;; *) die invalid_env STEWARD_YES ;; esac
case "$DRY_RUN" in 0|1) ;; *) die invalid_env STEWARD_DRY_RUN ;; esac
case "$READD" in 0|1) ;; *) die invalid_env STEWARD_READD_HERDR_KEY ;; esac
if [ "$HELP" = 1 ]; then tl installer_help; return 0; fi

IN=""
if [ -t 0 ]; then IN=/dev/stdin; elif (: </dev/tty) 2>/dev/null; then IN=/dev/tty; fi
if [ -n "$IN" ] && [ -z "$LANG_ARG" ] && [ -z "$SAVED_LANG" ] && [ "$YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then
	printf 'Language / 語言：1) 繁體中文  2) English  [Enter = %s] ' "$L"
	while :; do
		ans=""; read -r ans < "$IN" || break
		case "$ans" in 1) L=zh-TW; break ;; 2) L=en; break ;; '') break ;; *) t invalid_answer; printf ' ' ;; esac
	done
fi
export STEWARD_LANG="$L"
component_data
NODE_DOWNLOAD_URL=$NODE_SOURCE
need() { command -v "$1" >/dev/null 2>&1 || die need_command "$1"; }
need curl; need tar
OS=$(uname -s); ARCH=$(uname -m)
case "$OS" in Darwin) PLATFORM=macos ;; Linux) PLATFORM=linux ;; *) die unsupported_os "$OS" ;; esac
case "$ARCH" in arm64|aarch64) ARCH=aarch64 ;; x86_64|amd64) ARCH=x86_64 ;; *) die unsupported_arch "$ARCH" ;; esac

# 偵測安裝來源、既有程式與上次的選擇，不寫入 HOME。
IS_UPDATE=0; OLD_VERSION=""
if [ -f "$APP/REVISION" ]; then IS_UPDATE=1; OLD_VERSION=$(head -1 "$APP/REVISION"); fi
if [ -n "$FROM" ]; then
	[ -d "$FROM" ] || die invalid_from "$(tilde "$FROM")"
	FROM=$(cd "$FROM" && pwd)
	VERSION=$(git -C "$FROM" rev-parse --short HEAD 2>/dev/null || true)
	VERSION=${VERSION:-local-$(date +%Y%m%d%H%M)}
else
	if [ -z "$VERSION" ]; then VERSION=$(curl -fsSL --connect-timeout 10 --max-time 20 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true); fi
	VERSION=${VERSION:-main}
fi
NODE=""; NODE_SOURCE=existing; NODE_DOWNLOADED=0
node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' 2>/dev/null; }
[ -n "${STEWARD_FORCE_NODE_DOWNLOAD:-}" ] || for c in "$(command -v node 2>/dev/null || true)" "$LOCALBIN/node" /opt/homebrew/bin/node /usr/local/bin/node "$ROOT/node/bin/node"; do
	if [ -n "$c" ] && [ -x "$c" ] && node_ok "$c"; then NODE=$c; break; fi
done
TTYD=$(command -v ttyd 2>/dev/null || true); TTYD_SOURCE=existing
for c in /opt/homebrew/bin/ttyd /usr/local/bin/ttyd "$BINDIR/ttyd"; do
	if [ -z "$TTYD" ] && [ -x "$c" ]; then TTYD=$c; fi
done
BREW=$(command -v brew 2>/dev/null || true)
BREW_AVAILABLE=0; BREW_NODE=0
if [ "$PLATFORM" = macos ] && [ -n "$BREW" ] && [ -z "$NODE" ]; then BREW_AVAILABLE=1; fi
INSTALLED_HERDR_TAG=$(head -1 "$BINDIR/herdr.tag" 2>/dev/null || true)
HERDR_LINK_EXISTS=0
if [ -e "$LOCALBIN/herdr" ] || [ -L "$LOCALBIN/herdr" ]; then HERDR_LINK_EXISTS=1; fi
PREVIOUS_WITHOUT=$(read_string "$ROOT/install.json" without || true)
INHERITED=0
if [ "$IS_UPDATE" = 1 ] && [ "$WITHOUT_EXPLICIT" = 0 ]; then WITHOUT_INPUT=$PREVIOUS_WITHOUT; INHERITED=1; fi
WITHOUT=""
without() { case ",$WITHOUT," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
add_without() { without "$1" || WITHOUT="${WITHOUT:+$WITHOUT,}$1"; }
remove_without() {
	remaining=""; old_ifs=$IFS; IFS=,
	for part in $WITHOUT; do [ "$part" = "$1" ] || remaining="${remaining:+$remaining,}$part"; done
	IFS=$old_ifs; WITHOUT=$remaining
}
old_ifs=$IFS; IFS=,
for part in $WITHOUT_INPUT; do
	case "$part" in herdr|terminal|herdr-config|autostart|open|brew-node) add_without "$part" ;; *) IFS=$old_ifs; die invalid_component "$part" ;; esac
done
IFS=$old_ifs
if without herdr; then add_without terminal; add_without herdr-config; fi
if [ "$BREW_AVAILABLE" = 1 ]; then add_without brew-node; fi
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/settings.json" 2>/dev/null | head -1 || true)
TPORT=$(sed -n 's/.*"terminalPort"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/settings.json" 2>/dev/null | head -1 || true)
PORT=${PORT:-8791}; TPORT=${TPORT:-8792}

component_name() {
	case "$1" in herdr) t component_herdr ;; terminal) t component_terminal ;; herdr-config) t component_herdr_config ;; autostart) t component_autostart ;; open) t component_open ;; brew-node) t component_brew_node ;; esac
}
without_names() {
	separator=""
	for component in herdr terminal herdr-config autostart open brew-node; do
		if [ "$component" = brew-node ] && [ "$BREW_AVAILABLE" = 0 ]; then continue; fi
		if without "$component"; then printf '%s' "$separator"; component_name "$component"; separator=$(t list_separator); fi
	done
}
print_without() { names=$(without_names); [ -z "$names" ] || tl plan_without "$names"; return 0; }
print_plan() {
	printf '\n'
	if [ "$IS_UPDATE" = 1 ]; then
		tl plan_update_title "$OLD_VERSION" "$VERSION"
		extra=""
		if ! without herdr && [ "$INSTALLED_HERDR_TAG" != "$HERDR_TAG" ]; then extra=$(t update_herdr "$HERDR_TAG"); fi
		tl update_downloads "$SIZE_APP" "$SIZE_APP_DEPS" "$extra"
		if ! without autostart; then tl update_restart; fi
		if [ "$INHERITED" = 1 ]; then tl update_keep; else tl update_choices; fi
		print_without
	else
		tl plan_title "$VERSION"
		printf '\n'; tl plan_downloads
		tl plan_app "$VERSION" "$SIZE_APP" "$SIZE_APP_DEPS"
		if [ -n "$FROM" ]; then tl plan_local "$(tilde "$FROM")" "$VERSION"; fi
		if [ -n "$NODE" ]; then tl plan_existing Node.js "$(tilde "$NODE")"; elif [ "$BREW_NODE" = 1 ]; then tl plan_node_brew; else tl plan_node "$NODE_VERSION" "$SIZE_NODE"; fi
		if ! without herdr; then
			if [ "$INSTALLED_HERDR_TAG" = "$HERDR_TAG" ]; then tl plan_herdr_current "$HERDR_TAG"; else tl plan_herdr "$HERDR_TAG" "$SIZE_HERDR"; fi
		fi
		if ! without terminal; then
			if [ -n "$TTYD" ]; then tl plan_existing "$TTYD_NAME" "$(tilde "$TTYD")"; else
				tl plan_ttyd "$SIZE_TTYD"
				if [ "$PLATFORM" = macos ]; then if [ -n "$BREW" ]; then tl plan_ttyd_brew; else tl plan_ttyd_no_brew; fi; fi
			fi
		fi
		printf '\n'; tl plan_places
		tl plan_root "$(tilde "$ROOT")"; tl plan_steward "$(tilde "$LOCALBIN/steward")"
		if ! without herdr; then tl plan_herdr_link "$(tilde "$LOCALBIN/herdr")"; fi
		if ! without herdr-config; then
			tl plan_plugins "$(tilde "$PLUG")"; tl plan_config_header; tl plan_config "$(tilde "$(dirname "$PLUG")/config.toml")"
		fi
		if ! without autostart; then
			tl plan_autostart
			if [ "$PLATFORM" = macos ]; then
				labels=com.agent-steward; if ! without terminal; then labels="${labels}$(t list_separator)com.agent-steward.terminal"; fi
				tl plan_launchd "$labels"
			else
				labels=agent-steward; if ! without terminal; then labels="${labels}$(t list_separator)agent-steward-terminal"; fi
				tl plan_systemd "$labels"
			fi
		fi
		tl plan_network "$PORT"
		if ! without terminal; then tl plan_network_terminal "$TPORT"; fi
		tl plan_access; tl plan_wont; tl plan_remove "$(tilde "$APP")"; print_without
	fi
	printf '\n'
}
custom_item() {
	mark=x
	if [ "$2" = brew-node ]; then [ "$BREW_NODE" = 1 ] || mark=' '; elif without "$2"; then mark=' '; fi
	tl custom_item "$mark" "$1" "$(component_name "$2")" "$(t "$3")"
}
customize() {
	while :; do
		tl custom_title
		custom_item 1 herdr consequence_herdr
		custom_item 2 terminal consequence_terminal
		custom_item 3 herdr-config consequence_herdr_config
		custom_item 4 autostart consequence_autostart
		custom_item 5 open consequence_open
		if [ "$BREW_AVAILABLE" = 1 ]; then custom_item 6 brew-node consequence_brew_node; fi
		t custom_prompt; ans=""; read -r ans < "$IN" || return 0
		case "$ans" in
			'') return 0 ;; 1) selected=herdr ;; 2) selected=terminal ;; 3) selected=herdr-config ;;
			4) selected=autostart ;; 5) selected=open ;;
			6) if [ "$BREW_AVAILABLE" = 1 ]; then selected=brew-node; else tl invalid_answer; continue; fi ;;
			*) tl invalid_answer; continue ;;
		esac
		INHERITED=0
		if [ "$selected" = brew-node ]; then
			if [ "$BREW_NODE" = 0 ]; then BREW_NODE=1; remove_without brew-node; else BREW_NODE=0; add_without brew-node; fi
		elif without "$selected"; then
			remove_without "$selected"
			case "$selected" in terminal|herdr-config) remove_without herdr ;; esac
			if [ "$selected" = herdr-config ]; then
				case ",$PREVIOUS_WITHOUT," in *,herdr-config,*) READD=1 ;; esac
			fi
		else
			add_without "$selected"
			if [ "$selected" = herdr ]; then add_without terminal; add_without herdr-config; tl herdr_disabled; fi
		fi
	done
}
legacy_update_ok() {
	[ "$IS_UPDATE" = 1 ] && [ -f "$ROOT/update.lock" ] || return 1
	stamp=$(head -1 "$ROOT/update.lock" 2>/dev/null || true)
	awk -v now="$(date +%s)" -v stamp="$stamp" 'BEGIN {exit !(stamp ~ /^[0-9]+$/ && now * 1000 - stamp < 600000)}'
}
while :; do
	print_plan
	if [ "$DRY_RUN" = 1 ]; then return 0; fi
	if [ "$YES" = 1 ]; then break; fi
	if [ -z "$IN" ]; then
		if legacy_update_ok; then break; fi
		die no_tty
	fi
	if [ "$IS_UPDATE" = 1 ]; then t update_prompt; else tl install_choices; t install_prompt; fi
	ans=""; read -r ans < "$IN" || ans=cancel
	if [ "$IS_UPDATE" = 1 ]; then
		case "$ans" in ''|y|Y) break ;; n|N|cancel) tl cancelled; return 0 ;; c|C) customize ;; *) tl invalid_answer ;; esac
	else
		case "$ans" in ''|1) break ;; 3|cancel) tl cancelled; return 0 ;; 2) customize ;; *) tl invalid_answer ;; esac
	fi
done

# 使用者確認後才建立目錄與暫存檔。
mkdir -p "$ROOT" "$BINDIR" "$LOCALBIN" "$ROOT/logs"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rm -f "$ROOT/update.lock"' 0

# ---------- 1. Node.js（22.6 以上） ----------
if [ -z "$NODE" ]; then
	if [ "$BREW_NODE" = 1 ]; then
		say node_brew; "$BREW" install node >/dev/null
		NODE=$("$BREW" --prefix)/bin/node; NODE_SOURCE=brew
	else
		say node_download "$(tilde "$ROOT")"
		case "$PLATFORM-$ARCH" in macos-aarch64) NA=darwin-arm64 ;; macos-x86_64) NA=darwin-x64 ;; linux-aarch64) NA=linux-arm64 ;; linux-x86_64) NA=linux-x64 ;; esac
		BASE=${NODE_DOWNLOAD_URL%/}
		curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/node.sums" || die node_connect_failed
		LINE=$(awk -v na="$NA" '$2 ~ "node-v.*-"na".tar.gz$" {print; exit}' "$TMP/node.sums")
		FILE=$(printf '%s\n' "$LINE" | awk '{print $2}'); WANT=$(printf '%s\n' "$LINE" | awk '{print $1}')
		[ -n "$FILE" ] || die node_file_missing
		curl -fsSL "$BASE/$FILE" -o "$TMP/node.tgz"
		GOT=$( (shasum -a 256 "$TMP/node.tgz" 2>/dev/null || sha256sum "$TMP/node.tgz") | awk '{print $1}')
		[ "$WANT" = "$GOT" ] || die node_checksum_failed
		rm -rf "$ROOT/node"; mkdir -p "$ROOT/node"
		tar -xzf "$TMP/node.tgz" -C "$ROOT/node" --strip-components 1
		NODE="$ROOT/node/bin/node"; NODE_SOURCE=download; NODE_DOWNLOADED=1
	fi
fi
export PATH="$(dirname "$NODE"):$PATH"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM=$(command -v npm) || die npm_missing
say node_ready "$("$NODE" -v)" "$(tilde "$NODE")"

# ---------- 2. 專案管家程式 ----------
NEW="$APP.new.$$"
rm -rf "$NEW"; mkdir -p "$NEW"
if [ -n "$FROM" ]; then
	if [ -d "$FROM/.git" ]; then
		say app_from_git "$(tilde "$FROM")"
		git -C "$FROM" archive HEAD | tar -x -C "$NEW"
	else
		say app_from_dir "$(tilde "$FROM")"
		(cd "$FROM" && tar -cf - --exclude node_modules --exclude .git .) | tar -x -C "$NEW"
	fi
else
	if [ "$VERSION" = main ]; then URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"; else URL="https://codeload.github.com/$REPO/tar.gz/refs/tags/$VERSION"; fi
	say app_download "$VERSION"
	curl -fsSL "$URL" -o "$TMP/app.tgz" || die download_failed "$URL"
	tar -xzf "$TMP/app.tgz" -C "$NEW" --strip-components 1
fi
printf '%s\n' "$VERSION" > "$NEW/REVISION"
say deps_install
(cd "$NEW" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --update-notifier=false >/dev/null) || die deps_failed
chmod +x "$NEW/bin/"*.mjs 2>/dev/null || true
if [ -d "$APP" ]; then rm -rf "$APP.prev"; mv "$APP" "$APP.prev"; fi
mv "$NEW" "$APP"
say app_installed "$(tilde "$APP")" "$VERSION"
receipt() { "$NODE" --experimental-strip-types --no-warnings "$APP/src/install-receipt.ts" "$@"; }
receipt change file "$APP"
if [ "$NODE_DOWNLOADED" = 1 ]; then receipt change file "$ROOT/node"; fi

# ---------- 3. herdr ----------
HERDR="$LOCALBIN/herdr"
HERDR_SYMLINK=false
if [ -L "$HERDR" ] && [ "$(readlink "$HERDR")" = "$BINDIR/herdr" ]; then HERDR_SYMLINK=true; fi
if ! without herdr; then
	HREPO=$("$NODE" -e 'console.log(require(process.argv[1]).repo)' "$APP/herdr.json")
	HTAG=$("$NODE" -e 'console.log(require(process.argv[1]).tag)' "$APP/herdr.json")
	if [ "$INSTALLED_HERDR_TAG" != "$HTAG" ]; then
		ASSET="herdr-$PLATFORM-$ARCH"; say herdr_download "$HTAG" "$ASSET"
		if curl -fsSL "https://github.com/$HREPO/releases/download/$HTAG/$ASSET" -o "$TMP/herdr" && curl -fsSL "https://github.com/$HREPO/releases/download/$HTAG/$ASSET.sha256" -o "$TMP/herdr.sha256"; then
			WANT=$(awk '{print $1}' "$TMP/herdr.sha256")
			GOT=$( (shasum -a 256 "$TMP/herdr" 2>/dev/null || sha256sum "$TMP/herdr") | awk '{print $1}')
			[ "$WANT" = "$GOT" ] || die herdr_checksum_failed
			chmod +x "$TMP/herdr"; mv "$TMP/herdr" "$BINDIR/herdr"; printf '%s\n' "$HTAG" > "$BINDIR/herdr.tag"
			receipt change file "$BINDIR/herdr"; receipt change file "$BINDIR/herdr.tag"
		else warn herdr_download_failed; fi
	fi
	if [ -x "$BINDIR/herdr" ] && [ "$HERDR_LINK_EXISTS" = 0 ]; then
		ln -s "$BINDIR/herdr" "$HERDR"; HERDR_SYMLINK=true; receipt change symlink "$HERDR"
	fi
fi
[ -x "$HERDR" ] || HERDR="$BINDIR/herdr"

# ---------- 4. ttyd ----------
if ! without terminal && [ -z "$TTYD" ]; then
	if [ "$PLATFORM" = macos ] && [ -n "$BREW" ]; then
		say ttyd_brew
		if "$BREW" install ttyd >/dev/null; then TTYD=$("$BREW" --prefix)/bin/ttyd; TTYD_SOURCE=brew; fi
	elif [ "$PLATFORM" = linux ]; then
		say ttyd_download
		if curl -fsSL "${TTYD_SOURCE_LINUX}ttyd.$ARCH" -o "$BINDIR/ttyd"; then
			chmod +x "$BINDIR/ttyd"; TTYD="$BINDIR/ttyd"; TTYD_SOURCE=download; receipt change file "$TTYD"
		fi
	fi
	[ -n "$TTYD" ] || warn ttyd_missing
fi

# ---------- 5. steward 指令 ----------
if [ -L "$LOCALBIN/steward" ] || [ -f "$LOCALBIN/steward" ]; then rm -f "$LOCALBIN/steward"; fi
cat > "$LOCALBIN/steward" <<EOF
#!/bin/sh
exec "$NODE" "$APP/bin/steward.mjs" "\$@"
EOF
chmod +x "$LOCALBIN/steward"; receipt change file "$LOCALBIN/steward"
case ":$PATH:" in *":$LOCALBIN:"*) ;; *) warn path_missing "$(tilde "$LOCALBIN")" ;; esac

# ---------- 6. herdr 外掛與快捷鍵 ----------
if ! without herdr-config; then
	mkdir -p "$PLUG"
	for d in "$APP"/herdr-plugins/*/; do
		name=$(basename "$d"); mkdir -p "$PLUG/$name"
		for f in "$d"*; do
			[ "$(basename "$f")" = herdr-plugin.toml ] && continue
			cp -R "$f" "$PLUG/$name/"
		done
		sed "s#\"node\"#\"$NODE\"#g" "$d/herdr-plugin.toml" > "$PLUG/$name/herdr-plugin.toml.tmp"
		mv "$PLUG/$name/herdr-plugin.toml.tmp" "$PLUG/$name/herdr-plugin.toml"
		receipt change herdr-plugin "$PLUG/$name"
		if [ -x "$HERDR" ]; then "$HERDR" plugin link "$PLUG/$name" >/dev/null 2>&1 || warn plugin_link_failed "$name"; fi
	done
	if [ "$READD" = 1 ]; then
		STEWARD_NODE="$NODE" "$NODE" --experimental-strip-types --no-warnings "$APP/src/herdr-setup.ts" --readd || warn herdr_setup_failed
	else
		STEWARD_NODE="$NODE" "$NODE" --experimental-strip-types --no-warnings "$APP/src/herdr-setup.ts" || warn herdr_setup_failed
	fi
	[ -x "$HERDR" ] && "$HERDR" server reload-config >/dev/null 2>&1 || true
fi

# ---------- 7. 只更新仍接著的 agent 整合 ----------
STEWARD_APP_DIR="$APP" "$NODE" --experimental-strip-types --no-warnings "$APP/src/refresh-agents.ts" >/dev/null || warn agents_refresh_failed

ttyd_note() {
	if ! without terminal && [ -z "$TTYD" ]; then
		printf '\n'
		if [ "$PLATFORM" = macos ]; then warn ttyd_note_macos; tl ttyd_note_brew; tl ttyd_note_rerun; else warn ttyd_note_linux; fi
		printf '\n'
	fi
}

# ---------- 8. 登入時自動啟動 ----------
if without autostart; then say service_skipped; else
	PATHS="$LOCALBIN:$BINDIR:$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	if [ "$PLATFORM" = macos ]; then
		UID_=$(id -u)
		for old in "$HOME"/Library/LaunchAgents/com.*.agent-steward*.plist; do
			[ -f "$old" ] || continue
			case "$(basename "$old")" in com.agent-steward*) continue ;; esac
			launchctl bootout "gui/$UID_/$(basename "$old" .plist)" 2>/dev/null || true
			rm -f "$old"; say service_old_removed "$(basename "$old" .plist)"
		done
		service() {
			plist="$HOME/Library/LaunchAgents/$1.plist"
			cat > "$TMP/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--experimental-strip-types</string><string>--no-warnings</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATHS</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/$3.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$3.err.log</string>
</dict></plist>
EOF
			if ! cmp -s "$TMP/$1.plist" "$plist" 2>/dev/null; then
				mkdir -p "$(dirname "$plist")"; mv "$TMP/$1.plist" "$plist"
				receipt change launchd "$plist"
				launchctl bootout "gui/$UID_/$1" 2>/dev/null || true
				launchctl bootstrap "gui/$UID_" "$plist"
			elif ! launchctl print "gui/$UID_/$1" >/dev/null 2>&1; then launchctl bootstrap "gui/$UID_" "$plist"
			elif [ "$4" = 1 ]; then launchctl kickstart -k "gui/$UID_/$1" >/dev/null 2>&1
			fi
		}
		service com.agent-steward "$APP/src/main.ts" steward 1
		TCH=0; cmp -s "$APP/src/terminal-runner.ts" "$APP.prev/src/terminal-runner.ts" 2>/dev/null || TCH=1
		if ! without terminal && [ -n "$TTYD" ]; then service com.agent-steward.terminal "$APP/src/terminal-runner.ts" terminal "$TCH"; fi
	else
		UNIT="$HOME/.config/systemd/user"; mkdir -p "$UNIT"
		unit() {
			cat > "$UNIT/$1.service" <<EOF
[Unit]
Description=$1
[Service]
ExecStart=$NODE --experimental-strip-types --no-warnings $2
WorkingDirectory=$APP
Environment=PATH=$PATHS
Restart=always
RestartSec=10
StandardOutput=append:$ROOT/logs/$3.log
StandardError=append:$ROOT/logs/$3.err.log
[Install]
WantedBy=default.target
EOF
			receipt change systemd "$UNIT/$1.service"
		}
		unit agent-steward "$APP/src/main.ts" steward
		if ! without terminal && [ -n "$TTYD" ]; then unit agent-steward-terminal "$APP/src/terminal-runner.ts" terminal; fi
		systemctl --user daemon-reload
		systemctl --user enable --now agent-steward >/dev/null 2>&1 && systemctl --user restart agent-steward
		if ! without terminal && [ -n "$TTYD" ]; then systemctl --user enable --now agent-steward-terminal >/dev/null 2>&1 || true; fi
		if command -v loginctl >/dev/null 2>&1; then
			linger=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null || true)
			if [ "$linger" != Linger=yes ]; then
				if loginctl enable-linger "$(id -un)" 2>/dev/null; then
					receipt set '{"lingerByInstaller":true}'; receipt change linger "$(id -un)"
				else warn linger_failed; fi
			fi
		fi
	fi
fi

# ---------- 9. 收據與摘要 ----------
if [ -f "$BINDIR/herdr.tag" ]; then INSTALLED_HERDR_TAG=$(head -1 "$BINDIR/herdr.tag"); fi
patch=$("$NODE" -e 'const [lang,without,version,np,ns,tag,link,tp,ts]=process.argv.slice(1);console.log(JSON.stringify({lang,without,app:{version},node:{path:np,source:ns},herdr:{tag,symlink:link==="true"},ttyd:{path:tp,source:ts}}))' "$L" "$WITHOUT" "$VERSION" "$NODE" "$NODE_SOURCE" "$INSTALLED_HERDR_TAG" "$HERDR_SYMLINK" "$TTYD" "$TTYD_SOURCE")
receipt set "$patch"
URL="http://127.0.0.1:$PORT/"
if ! without autostart; then
	i=0
	until curl -fsS "${URL}api/health" >/dev/null 2>&1; do
		i=$((i + 1)); [ "$i" -gt 30 ] && die service_failed "$(tilde "$ROOT")"
		sleep 1
	done
fi
printf '\n'; tl summary_done "$VERSION"; tl summary_web "$PORT"
if without autostart; then tl summary_manual "$APP" "$NODE"; else
	if [ "$PLATFORM" = macos ]; then
		tl summary_service com.agent-steward "launchctl bootout gui/$(id -u)/com.agent-steward"
		if ! without terminal && [ -n "$TTYD" ]; then tl summary_service com.agent-steward.terminal "launchctl bootout gui/$(id -u)/com.agent-steward.terminal"; fi
	else
		tl summary_service agent-steward 'systemctl --user stop agent-steward'
		if ! without terminal && [ -n "$TTYD" ]; then tl summary_service agent-steward-terminal 'systemctl --user stop agent-steward-terminal'; fi
	fi
fi
tl summary_receipt "$(tilde "$ROOT")"; tl summary_remove "$(tilde "$APP")"; tl summary_privacy
receipt summary "$L"
ttyd_note
if ! without open && ! without autostart; then
	if [ "$PLATFORM" = macos ]; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
	say first_use
fi
}
main "$@"
