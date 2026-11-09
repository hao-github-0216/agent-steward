#!/bin/sh
# 移除專案管家（macOS／Linux）；--purge 連設定與資料一起刪除。
# herdr 本身不移除，設定備份保留。
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
		'zh-TW:win_herdr_key_removed') printf '%s' '你自己拿掉了 herdr 的資料夾導覽快捷鍵，這次不加回去。要加回來：再跑一次安裝並加上 -ReaddHerdrKey（用 irm | iex 時先執行 $env:STEWARD_READD_HERDR_KEY=1）。' ;;
		'en:win_herdr_key_removed') printf '%s' 'You removed the herdr folder-navigation shortcut, so it was not added back. To restore it, run the installer again with -ReaddHerdrKey (with irm | iex, run $env:STEWARD_READD_HERDR_KEY=1 first).' ;;
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
		'zh-TW:receipt_usage') printf '%s' '用法：install-receipt.ts set '\''<json>'\'' | set-file <path> | change <type> <path> [note] | backup <path> | get <key> | summary <lang> [header-key]' ;;
		'en:receipt_usage') printf '%s' 'Usage: install-receipt.ts set '\''<json>'\'' | set-file <path> | change <type> <path> [note] | backup <path> | get <key> | summary <lang> [header-key]' ;;
		'zh-TW:receipt_change_scheduled-task') printf '%s' '  工作排程器：%s%s' ;;
		'en:receipt_change_scheduled-task') printf '%s' '  Scheduled task: %s%s' ;;
		'zh-TW:win_installer_help') printf '%s' '用法：powershell -ExecutionPolicy Bypass -File install.ps1 [選項]
  -From DIR          從本機原始碼安裝
  -Version TAG       安裝指定版本
  -Yes               不再詢問是否開始安裝
  -DryRun            只列出計畫，不做改動
  -Without a,b       不安裝指定元件（herdr、terminal、herdr-config、autostart、open、path）
  -Lang zh-TW|en     指定訊息語言
  -ReaddHerdrKey     把你之前拿掉的 herdr 資料夾導覽快捷鍵加回來
  -SkipHerdr         等同 -Without herdr
  -NoOpen            等同 -Without open
  -NoService         等同 -Without autostart,open
用 irm | iex 時改用環境變數 STEWARD_YES、STEWARD_DRY_RUN、STEWARD_WITHOUT、STEWARD_LANG、STEWARD_READD_HERDR_KEY。
範例：powershell -ExecutionPolicy Bypass -File install.ps1 -From . -Yes -Without autostart,open' ;;
		'en:win_installer_help') printf '%s' 'Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [options]
  -From DIR          Install local source
  -Version TAG       Install a specific version
  -Yes               Skip installation confirmation
  -DryRun            Show the plan without making changes
  -Without a,b       Omit components (herdr, terminal, herdr-config, autostart, open, path)
  -Lang zh-TW|en     Set the message language
  -ReaddHerdrKey     Restore the herdr folder-navigation shortcut you removed
  -SkipHerdr         Same as -Without herdr
  -NoOpen            Same as -Without open
  -NoService         Same as -Without autostart,open
With irm | iex, use environment variables STEWARD_YES, STEWARD_DRY_RUN, STEWARD_WITHOUT, STEWARD_LANG, STEWARD_READD_HERDR_KEY instead.
Example: powershell -ExecutionPolicy Bypass -File install.ps1 -From . -Yes -Without autostart,open' ;;
		'zh-TW:win_plan_path') printf '%s' '  使用者 PATH：加入 %s，並把專案管家的 herdr 資料夾 %s 排在最前面' ;;
		'en:win_plan_path') printf '%s' '  User PATH: add %s, and put agent-steward'\''s herdr folder %s first' ;;
		'zh-TW:win_plan_autostart') printf '%s' '登入時自動在背景執行（掛掉會自動重開，不開視窗）：' ;;
		'en:win_plan_autostart') printf '%s' 'Run in the background at login (restarts on failure, no window):' ;;
		'zh-TW:win_plan_task') printf '%s' '  工作排程器：%s' ;;
		'en:win_plan_task') printf '%s' '  Task Scheduler: %s' ;;
		'zh-TW:win_plan_wont') printf '%s' '不會做：不改 AI agent 的設定（之後在「設定 → Agent」自己選）、不傳送任何使用資料、不需要系統管理員。' ;;
		'en:win_plan_wont') printf '%s' 'Will not change AI agent settings (choose integrations later in Settings → Agent), send usage data, or require administrator rights.' ;;
		'zh-TW:win_plan_remove') printf '%s' '移除：powershell -ExecutionPolicy Bypass -File %s\uninstall.ps1' ;;
		'en:win_plan_remove') printf '%s' 'Uninstall: powershell -ExecutionPolicy Bypass -File %s\uninstall.ps1' ;;
		'zh-TW:win_component_path') printf '%s' '把 steward 和 herdr 加進 PATH' ;;
		'en:win_component_path') printf '%s' 'Add steward and herdr to PATH' ;;
		'zh-TW:win_consequence_path') printf '%s' '關掉後，在終端機打 steward、herdr 找不到專案管家的版本。' ;;
		'en:win_consequence_path') printf '%s' 'Without it, typing steward or herdr in a terminal won'\''t find agent-steward'\''s versions.' ;;
		'zh-TW:win_no_tty') printf '%s' '這個視窗不能互動，尚未做任何改動。要直接安裝：先執行 $env:STEWARD_YES=1 再跑一次安裝指令，或用 -Yes 參數。' ;;
		'en:win_no_tty') printf '%s' 'This window is not interactive; nothing has changed. To install anyway, run $env:STEWARD_YES=1 and then the install command again, or pass -Yes.' ;;
		'zh-TW:win_summary_service') printf '%s' '  背景服務：工作排程器 %s；停止：Stop-ScheduledTask -TaskName %s' ;;
		'en:win_summary_service') printf '%s' '  Background service: Task Scheduler %s; stop: Stop-ScheduledTask -TaskName %s' ;;
		'zh-TW:win_path_removed') printf '%s' '已從使用者 PATH 拿掉：%s' ;;
		'en:win_path_removed') printf '%s' 'Removed from the user PATH: %s' ;;
		'zh-TW:win_plan_root') printf '%s' '  %s\   程式、Node、設定與資料' ;;
		'en:win_plan_root') printf '%s' '  %s\   App, Node, settings, and data' ;;
		'zh-TW:win_plan_plugins') printf '%s' '  %s\   兩個 herdr 外掛' ;;
		'en:win_plan_plugins') printf '%s' '  %s\   Two herdr plugins' ;;
		'zh-TW:win_plan_herdr') printf '%s' '  herdr %s（Windows 版 zip）   %s   github.com/hao-github-0216/herdr（Apache-2.0，修改版）' ;;
		'en:win_plan_herdr') printf '%s' '  herdr %s (Windows zip)   %s   github.com/hao-github-0216/herdr (Apache-2.0, modified build)' ;;
		'zh-TW:win_plan_ttyd') printf '%s' '  ttyd（網頁終端機，ttyd.win32.exe）   %s   github.com/tsl0922/ttyd（MIT）' ;;
		'en:win_plan_ttyd') printf '%s' '  ttyd (web terminal, ttyd.win32.exe)   %s   github.com/tsl0922/ttyd (MIT)' ;;
		'zh-TW:win_node_download') printf '%s' '下載 Node.js（放在 %s\node，不需要管理員權限）' ;;
		'en:win_node_download') printf '%s' 'Downloading Node.js (to %s\node, no administrator privileges needed)' ;;
		'zh-TW:win_git_archive_failed') printf '%s' '無法從本機原始碼建立安裝檔。' ;;
		'en:win_git_archive_failed') printf '%s' 'Could not archive the local source.' ;;
		'zh-TW:win_herdr_busy') printf '%s' 'herdr 正在執行，沒辦法換新版；關掉所有 herdr 視窗後再跑一次安裝。' ;;
		'en:win_herdr_busy') printf '%s' 'herdr is running and could not be replaced. Close all herdr windows and rerun the installer.' ;;
		'zh-TW:win_path_added') printf '%s' '已把 steward 和專案管家的 herdr 資料夾加進使用者 PATH（新開的終端機才會生效）。' ;;
		'en:win_path_added') printf '%s' 'Added steward and agent-steward'\''s herdr folder to the user PATH (takes effect in new terminals).' ;;
		'zh-TW:win_service_failed') printf '%s' '專案管家沒有啟動起來，請看 %s\steward.log。' ;;
		'en:win_service_failed') printf '%s' 'agent-steward did not start. See %s\steward.log.' ;;
		'zh-TW:win_summary_manual') printf '%s' '  手動啟動：Set-Location "%s"; & "%s" --experimental-strip-types --no-warnings src/main.ts' ;;
		'en:win_summary_manual') printf '%s' '  Start manually: Set-Location "%s"; & "%s" --experimental-strip-types --no-warnings src/main.ts' ;;
		'zh-TW:win_summary_receipt') printf '%s' '  這次的改動記在 %s\install.json' ;;
		'en:win_summary_receipt') printf '%s' '  Changes are recorded in %s\install.json' ;;
		'zh-TW:win_uninstall_kept') printf '%s' '已移除程式；資料留在 %s。要全部刪掉：Remove-Item -Recurse -Force "%s"' ;;
		'en:win_uninstall_kept') printf '%s' 'App removed; data remains in %s. To delete everything: Remove-Item -Recurse -Force "%s"' ;;
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
TTYD_SOURCE_WINDOWS='https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.win32.exe'
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
ROOT="$HOME/.agent-steward"
APP="$ROOT/app"
tilde() { case "$1" in "$HOME"|"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
PURGE=0; LANG_ARG="${STEWARD_LANG:-}"; ARG_ERROR=""; ARG_VALUE=""
while [ $# -gt 0 ]; do
	case "$1" in
		--purge) PURGE=1; shift ;;
		--lang)
			if [ $# -lt 2 ]; then ARG_ERROR=missing_value; ARG_VALUE=--lang; shift; else LANG_ARG=$2; shift 2; fi ;;
		--lang=*) LANG_ARG=${1#*=}; [ -n "$LANG_ARG" ] || { ARG_ERROR=missing_value; ARG_VALUE=--lang; }; shift ;;
		*) ARG_ERROR=unknown_option; ARG_VALUE=$1; shift ;;
	esac
done
normalize_lang() { case "$1" in zh|zh-*|zh_*|ZH|ZH-*|ZH_*) printf '%s' zh-TW ;; en) printf '%s' en ;; *) return 1 ;; esac; }
read_string() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -1; }
L=$(sed -n '/"ui"[[:space:]]*:[[:space:]]*{/,/}/s/.*"lang"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/settings.json" 2>/dev/null | head -1 || true)
L=$(normalize_lang "$L" || true)
if [ -z "$L" ]; then L=$(normalize_lang "$(read_string "$ROOT/install.json" lang || true)" || true); fi
if [ -z "$L" ] && [ -f "$APP/REVISION" ] && [ ! -f "$ROOT/install.json" ]; then L=zh-TW; fi
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
if [ -n "$LANG_ARG" ]; then
	chosen_lang=$(normalize_lang "$LANG_ARG" || true)
	if [ -z "$chosen_lang" ]; then tl invalid_lang "$LANG_ARG" >&2; exit 1; fi
	L=$chosen_lang
fi
if [ -n "$ARG_ERROR" ]; then tl "$ARG_ERROR" "$ARG_VALUE" >&2; exit 2; fi
export STEWARD_LANG="$L"
NODE=$(sed -n '/"node"[[:space:]]*:/,/}/s/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/install.json" 2>/dev/null | head -1 || true)
if [ ! -x "$NODE" ]; then NODE=$(sed -n 's/^exec "\([^"]*\)".*/\1/p' "$HOME/.local/bin/steward" 2>/dev/null || true); fi
[ -x "$NODE" ] || NODE=$(command -v node || true)
RECEIPT=0
if [ -n "$NODE" ] && [ -f "$ROOT/install.json" ] && [ -f "$APP/src/install-receipt.ts" ]; then RECEIPT=1; fi
receipt() { "$NODE" --experimental-strip-types --no-warnings "$APP/src/install-receipt.ts" "$@"; }
recorded() {
	[ "$RECEIPT" = 1 ] || return 0
	"$NODE" -e 'const fs=require("node:fs");const [file,type,path]=process.argv.slice(1);try{const r=JSON.parse(fs.readFileSync(file,"utf8"));process.exit((r.changes||[]).some(c=>c.type===type&&c.path===path)?0:1)}catch{process.exit(1)}' "$ROOT/install.json" "$1" "$2"
}

# 1. 程式還在時，拿掉 agent 整合與 herdr 快捷鍵。
if [ -n "$NODE" ] && [ -f "$APP/src/refresh-agents.ts" ]; then
	say uninstall_agents
	STEWARD_APP_DIR="$APP" "$NODE" --experimental-strip-types --no-warnings "$APP/src/refresh-agents.ts" --remove-all >/dev/null || true
fi
if [ -n "$NODE" ] && [ -f "$ROOT/settings.json" ] && [ -f "$APP/src/tailscale.ts" ]; then
	"$NODE" --experimental-strip-types --no-warnings "$APP/src/tailscale.ts" --serve-off >/dev/null || true
fi
if [ -n "$NODE" ] && [ -f "$APP/src/herdr-setup.ts" ]; then
	if [ "$RECEIPT" = 0 ] || [ "$(receipt get herdrKeyAdded)" = true ]; then
		"$NODE" --experimental-strip-types --no-warnings "$APP/src/herdr-setup.ts" --remove || true
	fi
fi

# 2. 只停止這個 HOME 裡有服務檔的服務。
if [ "$(uname -s)" = Darwin ]; then
	for label in com.agent-steward com.agent-steward.terminal; do
		plist="$HOME/Library/LaunchAgents/$label.plist"
		[ -f "$plist" ] || continue
		launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
		rm -f "$plist"
	done
else
	units_removed=0
	for unit in agent-steward agent-steward-terminal; do
		path="$HOME/.config/systemd/user/$unit.service"
		[ -f "$path" ] || continue
		systemctl --user disable --now "$unit" 2>/dev/null || true
		rm -f "$path"; units_removed=1
	done
	if [ "$units_removed" = 1 ]; then systemctl --user daemon-reload 2>/dev/null || true; fi
	if [ "$RECEIPT" = 1 ] && [ "$(receipt get lingerByInstaller)" = true ]; then
		if loginctl disable-linger "$(id -un)" 2>/dev/null; then say uninstall_linger; fi
	fi
fi
say uninstall_stopped

# 3. 外掛與指令：有收據時只移除記錄過的外掛。
HERDR=$(command -v herdr || printf '%s' "$ROOT/bin/herdr")
PLUG="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins-local"
for name in current-space-agents folder-nav; do
	if recorded herdr-plugin "$PLUG/$name"; then
		[ -x "$HERDR" ] && "$HERDR" plugin unlink "local.$name" >/dev/null 2>&1 || true
		rm -rf "$PLUG/$name"
	fi
done
if recorded file "$HOME/.local/bin/steward"; then rm -f "$HOME/.local/bin/steward"; fi
if [ -L "$HOME/.local/bin/herdr" ] && [ "$(readlink "$HOME/.local/bin/herdr")" = "$ROOT/bin/herdr" ]; then rm -f "$HOME/.local/bin/herdr"; fi

# 備份清單要在刪除程式和收據之前讀出。
if [ "$RECEIPT" = 1 ]; then
	receipt summary "$L" uninstall_receipt_header
	backups=$("$NODE" -e 'const fs=require("node:fs");try{for(const p of JSON.parse(fs.readFileSync(process.argv[1],"utf8")).backups||[])console.log(p)}catch{}' "$ROOT/install.json")
	if [ -n "$backups" ]; then
		tl uninstall_backups
		printf '%s\n' "$backups" | while IFS= read -r backup; do printf '  %s\n' "$(tilde "$backup")"; done
	fi
fi

# 4. 程式與資料。
if [ "$PURGE" = 1 ]; then
	rm -rf "$ROOT"; say uninstall_purged "$(tilde "$ROOT")"
else
	rm -rf "$APP" "$APP.prev" "$ROOT/node" "$ROOT/bin"
	say uninstall_kept "$(tilde "$ROOT")" "$(tilde "$ROOT")"
fi
}
main "$@"
