# 專案管家安裝／更新程式：Windows。
# 用 -DryRun 先看計畫；無法互動時加 -Yes。完整選項：powershell -File install.ps1 -Help。
# irm | iex 使用環境變數；直接執行檔案時使用參數。
& {
param(
	[string]$From = $env:STEWARD_FROM,
	[string]$Version = $env:STEWARD_VERSION,
	[switch]$SkipHerdr,
	[switch]$NoOpen,
	[switch]$NoService,
	[switch]$Yes,
	[switch]$DryRun,
	[string]$Without = $env:STEWARD_WITHOUT,
	[string]$Lang = $env:STEWARD_LANG,
	[switch]$ReaddHerdrKey,
	[switch]$Help
)
# ---- generated: begin (scripts/gen-install.mjs) ----
$Msg = @{
	'zh-TW' = @{
		'list_separator' = '、'
		'warning_prefix' = '注意：'
		'error_prefix' = '錯誤：'
		'missing_value' = '{0} 後面要接一個值。'
		'unknown_option' = '不認得的參數：{0}'
		'invalid_lang' = '不支援的語言：{0}。請用 zh-TW 或 en。'
		'invalid_component' = '不認得的元件：{0}'
		'invalid_env' = '{0} 的值不對，請用 0 或 1。'
		'need_command' = '需要 {0}。'
		'unsupported_os' = '不支援的系統：{0}（Windows 請用 install.ps1）。'
		'unsupported_arch' = '不支援的處理器：{0}'
		'invalid_from' = '找不到原始碼資料夾：{0}'
		'installer_help' = '用法：sh install.sh [選項]
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
範例：sh install.sh --from . --yes --without=autostart,open'
		'plan_title' = '專案管家 {0} 安裝程式 — 看完再決定要不要裝'
		'plan_update_title' = '專案管家 {0} → {1}'
		'plan_downloads' = '會下載：'
		'plan_app' = '  專案管家 {0} + 相依套件   {1} + {2}   github.com/hao-github-0216、registry.npmjs.org（MIT）'
		'plan_local' = '  程式來自本機原始碼：{0}（{1}）'
		'plan_node' = '  Node.js {0}   {1}   nodejs.org（MIT）'
		'plan_existing' = '  {0}：已有，沿用：{1}'
		'plan_node_brew' = '  Node.js：會執行 brew install node（Homebrew）'
		'plan_herdr' = '  herdr {0}   {1}   github.com/hao-github-0216/herdr（Apache-2.0，修改版）'
		'plan_herdr_current' = '  herdr：已是 {0}，不下載'
		'plan_ttyd' = '  ttyd（網頁終端機）   {0}   github.com/tsl0922/ttyd（MIT）'
		'plan_ttyd_brew' = '  macOS：會執行 brew install ttyd（Homebrew）'
		'plan_ttyd_no_brew' = '  macOS：ttyd 需要 Homebrew；沒有 Homebrew 時先略過，不會自動安裝 Homebrew。'
		'plan_places' = '會放東西的地方：'
		'plan_root' = '  {0}/   程式、Node、設定與資料'
		'plan_steward' = '  {0}   steward 指令'
		'plan_herdr_link' = '  {0}   herdr 指令（已經有就不動）'
		'plan_plugins' = '  {0}/   兩個 herdr 外掛'
		'plan_config_header' = '會修改其他程式的設定（先備份成 .bak-steward-日期）：'
		'plan_config' = '  {0}   加上或更新資料夾導覽快捷鍵 prefix+e（你自己拿掉的不會加回來）'
		'plan_autostart' = '登入時自動在背景執行（掛掉會自動重開）：'
		'plan_launchd' = '  macOS：LaunchAgent {0}（會出現在「系統設定 → 一般 → 登入項目」）'
		'plan_systemd' = '  Linux：systemd --user 的 {0}，並開啟 linger'
		'plan_network' = '網路：只聽 127.0.0.1:{0}（網頁），不開放給區網或 Tailscale。'
		'plan_network_terminal' = '      終端機只聽 127.0.0.1:{0}。'
		'plan_access' = '      要從手機連，裝完到「設定 → 存取」自己打開。'
		'plan_wont' = '不會做：不改 AI agent 的設定（之後在「設定 → Agent」自己選）、不傳送任何使用資料、不需要 sudo。'
		'plan_remove' = '移除：sh {0}/uninstall.sh'
		'plan_without' = '這次不裝：{0}'
		'update_downloads' = '會下載：專案管家和相依套件（{0} + {1}）{2}'
		'update_herdr' = '、herdr {0}'
		'update_restart' = '背景服務會重新啟動（開著的網頁終端機會斷線一次）。'
		'update_keep' = '沿用你上次的選擇，你自己拿掉的設定不會加回來。'
		'update_choices' = '使用這次的選擇，你自己拿掉的設定不會加回來。'
		'no_tty' = '沒有可互動的終端機，尚未做任何改動。請加 --yes，例如：curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh -s -- --yes'
		'install_choices' = '  1) 開始安裝   2) 自訂   3) 取消'
		'install_prompt' = '請選擇 [1]：'
		'update_prompt' = '繼續？[Y] 是  [n] 取消  [c] 自訂：'
		'cancelled' = '已取消，沒有做任何改動。'
		'invalid_answer' = '請輸入選單上的選項。'
		'custom_title' = '自訂安裝（輸入編號切換，按 Enter 回到計畫）：'
		'custom_item' = '  [{0}] {1} {2} — {3}'
		'custom_prompt' = '請輸入編號：'
		'component_herdr' = 'herdr'
		'component_terminal' = '網頁終端機'
		'component_herdr_config' = 'herdr 快捷鍵與外掛'
		'component_autostart' = '登入時自動啟動'
		'component_open' = '裝完打開瀏覽器'
		'component_brew_node' = '用 Homebrew 安裝 Node.js'
		'consequence_herdr' = '關掉後，終端機、自動記錄、派工都不能用；也會關掉網頁終端機和 herdr 快捷鍵與外掛。'
		'consequence_terminal' = '關掉後，網頁上不能開終端機。'
		'consequence_herdr_config' = '關掉後，沒有資料夾導覽 popup，agents 清單不會只顯示目前 space。'
		'consequence_autostart' = '關掉後，要自己執行才會跑。'
		'consequence_open' = '關掉後，裝完不打開瀏覽器。'
		'consequence_brew_node' = '預設關閉；關掉時下載 Node.js 到 ~/.agent-steward/node，不會用 brew 安裝。'
		'herdr_disabled' = '已一起關掉網頁終端機和 herdr 快捷鍵與外掛。'
		'node_brew' = '安裝 Node.js（Homebrew）'
		'node_download' = '下載 Node.js（放在 {0}/node，不需要管理員權限）'
		'node_connect_failed' = '連不上 nodejs.org。'
		'node_file_missing' = '找不到 Node.js 下載檔。'
		'node_checksum_failed' = 'Node.js 檔案驗證失敗（sha256 不符）。'
		'npm_missing' = '找不到 npm。'
		'node_ready' = 'Node.js {0}（{1}）'
		'app_from_git' = '從本機原始碼安裝（{0} 目前的 commit）'
		'app_from_dir' = '從本機資料夾安裝（{0}）'
		'app_download' = '下載專案管家 {0}'
		'download_failed' = '下載失敗：{0}'
		'deps_install' = '安裝相依套件'
		'deps_failed' = '安裝相依套件失敗。'
		'app_installed' = '已安裝到 {0}（{1}）'
		'herdr_download' = '下載 herdr {0}（{1}）'
		'herdr_checksum_failed' = 'herdr 檔案驗證失敗（sha256 不符）。'
		'herdr_download_failed' = '下載 herdr 失敗：終端機、自動記錄、派工會先無法使用，之後再跑一次安裝即可。'
		'ttyd_brew' = '安裝 ttyd（Homebrew）'
		'ttyd_download' = '下載 ttyd'
		'ttyd_missing' = '沒有 ttyd：網頁終端機先無法使用，其他功能照常。裝完最後會說明怎麼補上。'
		'path_missing' = '{0} 不在 PATH 裡。要用 steward 指令，請把它加進 shell 設定，例如 ~/.zshrc。'
		'plugin_link_failed' = 'herdr 外掛 {0} 沒有接上。herdr 可能還沒啟動過，之後再跑一次安裝即可。'
		'herdr_setup_failed' = '設定 herdr 的資料夾導覽失敗。'
		'agents_refresh_failed' = '更新 agent 整合失敗。'
		'ttyd_note_macos' = '網頁終端機需要 ttyd，而 macOS 上的 ttyd 要用 Homebrew 安裝。要用網頁終端機的話：'
		'ttyd_note_brew' = '    1. 安裝 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
		'ttyd_note_rerun' = '    2. 再跑一次專案管家的安裝指令，會自動裝好 ttyd。'
		'ttyd_note_linux' = '網頁終端機需要 ttyd，但下載失敗了。再跑一次安裝指令即可補上。'
		'service_skipped' = '略過登入時自動啟動。'
		'service_old_removed' = '移除舊的服務 {0}'
		'service_failed' = '專案管家沒有啟動起來，請看 {0}/logs/steward.err.log。'
		'linger_failed' = '沒有開啟 linger，登出後背景服務可能停止。'
		'summary_done' = '專案管家 {0} 已經裝好。'
		'summary_web' = '  網頁：http://127.0.0.1:{0}/（只有這台電腦連得到）'
		'summary_service' = '  背景服務：{0}；停止：{1}'
		'summary_manual' = '  手動啟動：cd "{0}" && "{1}" --experimental-strip-types --no-warnings src/main.ts'
		'summary_receipt' = '  這次的改動記在 {0}/install.json'
		'summary_remove' = '  移除：sh {0}/uninstall.sh'
		'summary_privacy' = '  專案管家不會傳送任何使用資料。'
		'first_use' = '第一次使用：在瀏覽器裡設定管理密碼、AI 接口和要接上的 agent。'
		'uninstall_agents' = '拿掉各 agent 的專案管家整合'
		'uninstall_stopped' = '已停止服務'
		'uninstall_linger' = '已關閉安裝程式開啟的 linger。'
		'uninstall_backups' = '這些備份檔留著，要刪可以自己刪：'
		'uninstall_purged' = '已刪除 {0}（含所有資料）'
		'uninstall_kept' = '已移除程式；資料留在 {0}。要全部刪掉：rm -rf {1}'
		'herdr_key_removed' = '你自己拿掉了 herdr 的資料夾導覽快捷鍵，這次不加回去。要加回來：再跑一次安裝並加上 --readd-herdr-key。'
		'win_herdr_key_removed' = '你自己拿掉了 herdr 的資料夾導覽快捷鍵，這次不加回去。要加回來：再跑一次安裝並加上 -ReaddHerdrKey（用 irm | iex 時先執行 $env:STEWARD_READD_HERDR_KEY=1）。'
		'herdr_folder_description' = '資料夾導覽'
		'herdr_config_removed' = 'herdr 設定：已拿掉資料夾導覽'
		'herdr_config_absent' = 'herdr 設定：沒有資料夾導覽'
		'herdr_config_updated' = 'herdr 設定：已加上或更新資料夾導覽（{0}）'
		'herdr_config_current' = 'herdr 設定：資料夾導覽已經是最新的'
		'receipt_header' = '安裝程式做過的改動（記在 install.json）：'
		'uninstall_receipt_header' = '安裝時做過的改動（已移除）：'
		'receipt_change_file' = '  檔案：{0}{1}'
		'receipt_change_modified' = '  修改設定：{0}{1}'
		'receipt_change_symlink' = '  連結：{0}{1}'
		'receipt_change_launchd' = '  LaunchAgent：{0}{1}'
		'receipt_change_systemd' = '  systemd 服務：{0}{1}'
		'receipt_change_linger' = '  linger：{0}{1}'
		'receipt_change_herdr-plugin' = '  herdr 外掛：{0}{1}'
		'receipt_backup' = '  備份：{0}'
		'receipt_error' = '收據錯誤：{0}'
		'receipt_usage' = '用法：install-receipt.ts set ''<json>'' | set-file <path> | change <type> <path> [note] | backup <path> | get <key> | summary <lang> [header-key]'
		'receipt_change_scheduled-task' = '  工作排程器：{0}{1}'
		'win_installer_help' = '用法：powershell -ExecutionPolicy Bypass -File install.ps1 [選項]
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
範例：powershell -ExecutionPolicy Bypass -File install.ps1 -From . -Yes -Without autostart,open'
		'win_plan_path' = '  使用者 PATH：加入 {0}，並把專案管家的 herdr 資料夾 {1} 排在最前面'
		'win_plan_autostart' = '登入時自動在背景執行（掛掉會自動重開，不開視窗）：'
		'win_plan_task' = '  工作排程器：{0}'
		'win_plan_wont' = '不會做：不改 AI agent 的設定（之後在「設定 → Agent」自己選）、不傳送任何使用資料、不需要系統管理員。'
		'win_plan_remove' = '移除：powershell -ExecutionPolicy Bypass -File {0}\uninstall.ps1'
		'win_component_path' = '把 steward 和 herdr 加進 PATH'
		'win_consequence_path' = '關掉後，在終端機打 steward、herdr 找不到專案管家的版本。'
		'win_no_tty' = '這個視窗不能互動，尚未做任何改動。要直接安裝：先執行 $env:STEWARD_YES=1 再跑一次安裝指令，或用 -Yes 參數。'
		'win_summary_service' = '  背景服務：工作排程器 {0}；停止：Stop-ScheduledTask -TaskName {1}'
		'win_path_removed' = '已從使用者 PATH 拿掉：{0}'
		'win_plan_root' = '  {0}\   程式、Node、設定與資料'
		'win_plan_plugins' = '  {0}\   兩個 herdr 外掛'
		'win_plan_herdr' = '  herdr {0}（Windows 版 zip）   {1}   github.com/hao-github-0216/herdr（Apache-2.0，修改版）'
		'win_plan_ttyd' = '  ttyd（網頁終端機，ttyd.win32.exe）   {0}   github.com/tsl0922/ttyd（MIT）'
		'win_node_download' = '下載 Node.js（放在 {0}\node，不需要管理員權限）'
		'win_git_archive_failed' = '無法從本機原始碼建立安裝檔。'
		'win_herdr_busy' = 'herdr 正在執行，沒辦法換新版；關掉所有 herdr 視窗後再跑一次安裝。'
		'win_path_added' = '已把 steward 和專案管家的 herdr 資料夾加進使用者 PATH（新開的終端機才會生效）。'
		'win_service_failed' = '專案管家沒有啟動起來，請看 {0}\steward.log。'
		'win_summary_manual' = '  手動啟動：Set-Location "{0}"; & "{1}" --experimental-strip-types --no-warnings src/main.ts'
		'win_summary_receipt' = '  這次的改動記在 {0}\install.json'
		'win_uninstall_kept' = '已移除程式；資料留在 {0}。要全部刪掉：Remove-Item -Recurse -Force "{1}"'
	}
	'en' = @{
		'list_separator' = ', '
		'warning_prefix' = 'Warning: '
		'error_prefix' = 'Error: '
		'missing_value' = '{0} requires a value.'
		'unknown_option' = 'Unknown option: {0}'
		'invalid_lang' = 'Unsupported language: {0}. Use zh-TW or en.'
		'invalid_component' = 'Unknown component: {0}'
		'invalid_env' = 'Invalid value for {0}. Use 0 or 1.'
		'need_command' = 'Required command: {0}.'
		'unsupported_os' = 'Unsupported system: {0}. On Windows, use install.ps1.'
		'unsupported_arch' = 'Unsupported processor: {0}'
		'invalid_from' = 'Source directory not found: {0}'
		'installer_help' = 'Usage: sh install.sh [options]
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
Example: sh install.sh --from . --yes --without=autostart,open'
		'plan_title' = 'agent-steward {0} installer — review before installing'
		'plan_update_title' = 'agent-steward {0} → {1}'
		'plan_downloads' = 'Downloads:'
		'plan_app' = '  agent-steward {0} + dependencies   {1} + {2}   github.com/hao-github-0216, registry.npmjs.org (MIT)'
		'plan_local' = '  App source: {0} ({1})'
		'plan_node' = '  Node.js {0}   {1}   nodejs.org (MIT)'
		'plan_existing' = '  {0}: already installed, reuse: {1}'
		'plan_node_brew' = '  Node.js: run brew install node (Homebrew)'
		'plan_herdr' = '  herdr {0}   {1}   github.com/hao-github-0216/herdr (Apache-2.0, modified build)'
		'plan_herdr_current' = '  herdr: already at {0}, no download'
		'plan_ttyd' = '  ttyd (web terminal)   {0}   github.com/tsl0922/ttyd (MIT)'
		'plan_ttyd_brew' = '  macOS: run brew install ttyd (Homebrew)'
		'plan_ttyd_no_brew' = '  macOS: ttyd requires Homebrew; skip it if Homebrew is unavailable. Homebrew will not be installed.'
		'plan_places' = 'Install locations:'
		'plan_root' = '  {0}/   App, Node, settings, and data'
		'plan_steward' = '  {0}   steward command'
		'plan_herdr_link' = '  {0}   herdr command (leave existing commands untouched)'
		'plan_plugins' = '  {0}/   Two herdr plugins'
		'plan_config_header' = 'Other settings to change (backed up as .bak-steward-date first):'
		'plan_config' = '  {0}   Add or update the prefix+e folder shortcut (do not restore shortcuts you removed)'
		'plan_autostart' = 'Run in the background at login (restart on failure):'
		'plan_launchd' = '  macOS: LaunchAgent {0} (shown in System Settings → General → Login Items)'
		'plan_systemd' = '  Linux: systemd --user units {0}, with linger enabled'
		'plan_network' = 'Network: listen only on 127.0.0.1:{0} (web), not on LAN or Tailscale.'
		'plan_network_terminal' = '         The terminal listens only on 127.0.0.1:{0}.'
		'plan_access' = '         To connect from a phone, enable access in Settings → Access after installing.'
		'plan_wont' = 'Will not change AI agent settings (choose integrations later in Settings → Agent), send usage data, or require sudo.'
		'plan_remove' = 'Uninstall: sh {0}/uninstall.sh'
		'plan_without' = 'Omitted this time: {0}'
		'update_downloads' = 'Downloads: agent-steward and dependencies ({0} + {1}){2}'
		'update_herdr' = ', herdr {0}'
		'update_restart' = 'Background services will restart (open web terminals will disconnect once).'
		'update_keep' = 'Keep your previous choices. Settings you removed will not be added back.'
		'update_choices' = 'Use the choices shown here. Settings you removed will not be added back.'
		'no_tty' = 'No interactive terminal; nothing has changed. Add --yes, for example: curl -fsSL https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.sh | sh -s -- --yes'
		'install_choices' = '  1) Install   2) Customize   3) Cancel'
		'install_prompt' = 'Choose [1]: '
		'update_prompt' = 'Continue? [Y] yes  [n] cancel  [c] customize: '
		'cancelled' = 'Cancelled. Nothing has changed.'
		'invalid_answer' = 'Enter one of the menu options.'
		'custom_title' = 'Customize (enter a number to toggle; Enter returns to the plan):'
		'custom_item' = '  [{0}] {1} {2} — {3}'
		'custom_prompt' = 'Number: '
		'component_herdr' = 'herdr'
		'component_terminal' = 'Web terminal'
		'component_herdr_config' = 'herdr shortcuts and plugins'
		'component_autostart' = 'Start at login'
		'component_open' = 'Open the browser after installing'
		'component_brew_node' = 'Install Node.js with Homebrew'
		'consequence_herdr' = 'Without it, terminals, automatic recording, and dispatch are unavailable; also disables the web terminal and herdr configuration.'
		'consequence_terminal' = 'Without it, web terminals are unavailable.'
		'consequence_herdr_config' = 'Without it, no folder navigation popup and no agents list filtered to the current space.'
		'consequence_autostart' = 'Without it, start the app manually.'
		'consequence_open' = 'Without it, the browser stays closed.'
		'consequence_brew_node' = 'Off by default. When off, download Node.js to ~/.agent-steward/node instead of using brew.'
		'herdr_disabled' = 'Also disabled the web terminal and herdr configuration.'
		'node_brew' = 'Installing Node.js (Homebrew)'
		'node_download' = 'Downloading Node.js (to {0}/node, no administrator privileges needed)'
		'node_connect_failed' = 'Cannot connect to nodejs.org.'
		'node_file_missing' = 'Node.js download not found.'
		'node_checksum_failed' = 'Node.js verification failed (sha256 mismatch).'
		'npm_missing' = 'npm not found.'
		'node_ready' = 'Node.js {0} ({1})'
		'app_from_git' = 'Installing the current commit from local source ({0})'
		'app_from_dir' = 'Installing from a local directory ({0})'
		'app_download' = 'Downloading agent-steward {0}'
		'download_failed' = 'Download failed: {0}'
		'deps_install' = 'Installing dependencies'
		'deps_failed' = 'Dependency installation failed.'
		'app_installed' = 'Installed to {0} ({1})'
		'herdr_download' = 'Downloading herdr {0} ({1})'
		'herdr_checksum_failed' = 'herdr verification failed (sha256 mismatch).'
		'herdr_download_failed' = 'herdr download failed. Terminals, automatic recording, and dispatch are unavailable until you rerun the installer.'
		'ttyd_brew' = 'Installing ttyd (Homebrew)'
		'ttyd_download' = 'Downloading ttyd'
		'ttyd_missing' = 'ttyd is unavailable. Other features still work; instructions for adding the web terminal follow below.'
		'path_missing' = '{0} is not in PATH. Add it to your shell configuration (for example, ~/.zshrc) to use steward.'
		'plugin_link_failed' = 'Could not link herdr plugin {0}. If herdr has not started yet, rerun the installer later.'
		'herdr_setup_failed' = 'Could not configure herdr folder navigation.'
		'agents_refresh_failed' = 'Could not refresh agent integrations.'
		'ttyd_note_macos' = 'The web terminal requires ttyd. On macOS, install it with Homebrew:'
		'ttyd_note_brew' = '    1. Install Homebrew: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
		'ttyd_note_rerun' = '    2. Rerun the agent-steward installer to install ttyd.'
		'ttyd_note_linux' = 'The ttyd download failed. Rerun the installer to add the web terminal.'
		'service_skipped' = 'Skipping start at login.'
		'service_old_removed' = 'Removed old service {0}'
		'service_failed' = 'agent-steward did not start. See {0}/logs/steward.err.log.'
		'linger_failed' = 'Could not enable linger; background services may stop after logout.'
		'summary_done' = 'agent-steward {0} is installed.'
		'summary_web' = '  Web: http://127.0.0.1:{0}/ (only reachable from this computer)'
		'summary_service' = '  Background service: {0}; stop with: {1}'
		'summary_manual' = '  Start manually: cd "{0}" && "{1}" --experimental-strip-types --no-warnings src/main.ts'
		'summary_receipt' = '  Changes are recorded in {0}/install.json'
		'summary_remove' = '  Uninstall: sh {0}/uninstall.sh'
		'summary_privacy' = '  agent-steward does not send usage data.'
		'first_use' = 'On first use, configure an admin password, AI providers, and agent integrations in your browser.'
		'uninstall_agents' = 'Removing agent-steward integrations'
		'uninstall_stopped' = 'Services stopped'
		'uninstall_linger' = 'Disabled linger that was enabled by the installer.'
		'uninstall_backups' = 'These backups were kept. You can delete them yourself:'
		'uninstall_purged' = 'Deleted {0}, including all data'
		'uninstall_kept' = 'App removed; data remains in {0}. To delete everything: rm -rf {1}'
		'herdr_key_removed' = 'You removed the herdr folder-navigation shortcut, so it was not added back. To restore it, run the installer again with --readd-herdr-key.'
		'win_herdr_key_removed' = 'You removed the herdr folder-navigation shortcut, so it was not added back. To restore it, run the installer again with -ReaddHerdrKey (with irm | iex, run $env:STEWARD_READD_HERDR_KEY=1 first).'
		'herdr_folder_description' = 'Folder navigation'
		'herdr_config_removed' = 'herdr configuration: removed folder navigation'
		'herdr_config_absent' = 'herdr configuration: no folder navigation'
		'herdr_config_updated' = 'herdr configuration: added or updated folder navigation ({0})'
		'herdr_config_current' = 'herdr configuration: folder navigation is up to date'
		'receipt_header' = 'Changes made by the installer (recorded in install.json):'
		'uninstall_receipt_header' = 'Changes made at install time (now removed):'
		'receipt_change_file' = '  File: {0}{1}'
		'receipt_change_modified' = '  Modified settings: {0}{1}'
		'receipt_change_symlink' = '  Symlink: {0}{1}'
		'receipt_change_launchd' = '  LaunchAgent: {0}{1}'
		'receipt_change_systemd' = '  systemd unit: {0}{1}'
		'receipt_change_linger' = '  Linger: {0}{1}'
		'receipt_change_herdr-plugin' = '  herdr plugin: {0}{1}'
		'receipt_backup' = '  Backup: {0}'
		'receipt_error' = 'Receipt error: {0}'
		'receipt_usage' = 'Usage: install-receipt.ts set ''<json>'' | set-file <path> | change <type> <path> [note] | backup <path> | get <key> | summary <lang> [header-key]'
		'receipt_change_scheduled-task' = '  Scheduled task: {0}{1}'
		'win_installer_help' = 'Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [options]
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
Example: powershell -ExecutionPolicy Bypass -File install.ps1 -From . -Yes -Without autostart,open'
		'win_plan_path' = '  User PATH: add {0}, and put agent-steward''s herdr folder {1} first'
		'win_plan_autostart' = 'Run in the background at login (restarts on failure, no window):'
		'win_plan_task' = '  Task Scheduler: {0}'
		'win_plan_wont' = 'Will not change AI agent settings (choose integrations later in Settings → Agent), send usage data, or require administrator rights.'
		'win_plan_remove' = 'Uninstall: powershell -ExecutionPolicy Bypass -File {0}\uninstall.ps1'
		'win_component_path' = 'Add steward and herdr to PATH'
		'win_consequence_path' = 'Without it, typing steward or herdr in a terminal won''t find agent-steward''s versions.'
		'win_no_tty' = 'This window is not interactive; nothing has changed. To install anyway, run $env:STEWARD_YES=1 and then the install command again, or pass -Yes.'
		'win_summary_service' = '  Background service: Task Scheduler {0}; stop: Stop-ScheduledTask -TaskName {1}'
		'win_path_removed' = 'Removed from the user PATH: {0}'
		'win_plan_root' = '  {0}\   App, Node, settings, and data'
		'win_plan_plugins' = '  {0}\   Two herdr plugins'
		'win_plan_herdr' = '  herdr {0} (Windows zip)   {1}   github.com/hao-github-0216/herdr (Apache-2.0, modified build)'
		'win_plan_ttyd' = '  ttyd (web terminal, ttyd.win32.exe)   {0}   github.com/tsl0922/ttyd (MIT)'
		'win_node_download' = 'Downloading Node.js (to {0}\node, no administrator privileges needed)'
		'win_git_archive_failed' = 'Could not archive the local source.'
		'win_herdr_busy' = 'herdr is running and could not be replaced. Close all herdr windows and rerun the installer.'
		'win_path_added' = 'Added steward and agent-steward''s herdr folder to the user PATH (takes effect in new terminals).'
		'win_service_failed' = 'agent-steward did not start. See {0}\steward.log.'
		'win_summary_manual' = '  Start manually: Set-Location "{0}"; & "{1}" --experimental-strip-types --no-warnings src/main.ts'
		'win_summary_receipt' = '  Changes are recorded in {0}\install.json'
		'win_uninstall_kept' = 'App removed; data remains in {0}. To delete everything: Remove-Item -Recurse -Force "{1}"'
	}
}
function T([string]$k) { $s = $Msg[$L][$k]; if ($null -eq $s) { $s = $k }; if ($args.Count) { $s -f $args } else { $s -replace '\{\{','{' -replace '\}\}','}' } }
$AppLicense = 'MIT'
$AppHome = 'https://github.com/hao-github-0216/agent-steward'
$NodeVersion = '22'
$NodeLicense = 'MIT'
$NodeHome = 'https://nodejs.org'
$NodeSource = 'https://nodejs.org/dist/latest-v22.x/'
$HerdrRepo = 'hao-github-0216/herdr'
$HerdrTag = 'steward-v0.9.5-1'
$HerdrLicense = 'Apache-2.0'
$HerdrHome = 'https://github.com/hao-github-0216/herdr'
$TtydLicense = 'MIT'
$TtydHome = 'https://github.com/tsl0922/ttyd'
$TtydSourceLinux = 'https://github.com/tsl0922/ttyd/releases/latest/download/'
$TtydSourceMacos = 'brew'
$TtydSourceWindows = 'https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.win32.exe'
function Set-ComponentData {
	switch ($L) {
		'zh-TW' {
			$AppName = '專案管家'
			$SizeApp = '約 2 MB'
			$SizeAppDeps = '約 110 MB'
			$NodeName = 'Node.js'
			$SizeNode = '約 45 MB'
			$HerdrName = 'herdr'
			$HerdrNote = '專案管家用的 herdr 版本(上游 v0.9.5 加上資料夾導覽等修改)。安裝程式從這個 release 下載。'
			$SizeHerdr = '約 10 MB'
			$TtydName = 'ttyd（網頁終端機）'
			$SizeTtyd = '約 2 MB'
		}
		'en' {
			$AppName = 'agent-steward'
			$SizeApp = '~2 MB'
			$SizeAppDeps = '~110 MB'
			$NodeName = 'Node.js'
			$SizeNode = '~45 MB'
			$HerdrName = 'herdr'
			$HerdrNote = 'The herdr build for agent-steward (upstream v0.9.5 with folder navigation and other changes). The installer downloads this release.'
			$SizeHerdr = '~10 MB'
			$TtydName = 'ttyd (web terminal)'
			$SizeTtyd = '~2 MB'
		}
	}
}
# ---- generated: end ----

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo = if ($env:STEWARD_REPO) { $env:STEWARD_REPO } else { "hao-github-0216/agent-steward" }
$Root = Join-Path $HOME ".agent-steward"
$App = Join-Path $Root "app"
$Bin = Join-Path $Root "bin"
$LocalBin = Join-Path $HOME ".local\bin"
$Logs = Join-Path $Root "logs"
$HerdrDir = Join-Path $Bin "herdr"
$TtydPath = Join-Path $Bin "ttyd.exe"
$Plug = Join-Path $env:APPDATA "herdr\plugins-local"
$Runner = Join-Path $Root "run-service.ps1"
$L = if ((Get-UICulture).Name -like "zh*") { "zh-TW" } else { "en" }
$Tmp = $null
$Confirmed = $false
$Failed = $false

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host ((T 'warning_prefix') + $m) -ForegroundColor Yellow }
# irm | iex 時不能 exit，否則會關掉使用者的視窗。
function Die($m) { throw $m }
function Read-Json($Path) {
	try { Get-Content $Path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}
function Normalize-Language([string]$Value) {
	if ($Value -match '^zh($|[-_])') { return "zh-TW" }
	if ($Value -eq "en") { return "en" }
	return ""
}
function Display-Path([string]$Path) {
	if ($env:APPDATA -and ($Path -eq $env:APPDATA -or $Path.StartsWith("$env:APPDATA\", [StringComparison]::OrdinalIgnoreCase))) {
		return "%APPDATA%" + $Path.Substring($env:APPDATA.Length)
	}
	if ($Path -eq $HOME -or $Path.StartsWith("$HOME\", [StringComparison]::OrdinalIgnoreCase)) {
		return "~" + $Path.Substring($HOME.Length)
	}
	return $Path
}
function Test-Node($Exe) {
	if (-not $Exe -or -not (Test-Path $Exe -PathType Leaf)) { return $false }
	try {
		return ((& $Exe -e "const [a,b]=process.versions.node.split('.').map(Number);console.log(a>22||(a===22&&b>=6)?'ok':'old')") -eq "ok")
	} catch { return $false }
}

try {
	# 語言與互動能力的偵測不建立目錄。
	$Settings = Read-Json (Join-Path $Root "settings.json")
	$InstallReceipt = Read-Json (Join-Path $Root "install.json")
	$SavedLang = Normalize-Language $Settings.ui.lang
	if (-not $SavedLang) { $SavedLang = Normalize-Language $InstallReceipt.lang }
	if (-not $SavedLang -and (Test-Path (Join-Path $App "REVISION") -PathType Leaf)) { $SavedLang = "zh-TW" }
	if ($SavedLang) { $L = $SavedLang }
	if ($Lang) {
		$ChosenLang = Normalize-Language $Lang
		if (-not $ChosenLang) { Die (T 'invalid_lang' $Lang) }
		$L = $ChosenLang
	}
	foreach ($Name in @("STEWARD_YES", "STEWARD_DRY_RUN", "STEWARD_READD_HERDR_KEY")) {
		$Value = [Environment]::GetEnvironmentVariable($Name)
		if ($Value -and $Value -notin @("0", "1")) { Die (T 'invalid_env' $Name) }
	}
	$Yes = $Yes -or $env:STEWARD_YES -eq "1"
	$DryRun = $DryRun -or $env:STEWARD_DRY_RUN -eq "1"
	$ReaddHerdrKey = $ReaddHerdrKey -or $env:STEWARD_READD_HERDR_KEY -eq "1"
	if ($env:STEWARD_SKIP_HERDR) { $SkipHerdr = $true }
	if ($env:STEWARD_NO_OPEN) { $NoOpen = $true }
	if ($env:STEWARD_NO_SERVICE) { $NoService = $true }
	$WithoutExplicit = $PSBoundParameters.ContainsKey("Without") -or [bool]$Without -or $SkipHerdr -or $NoOpen -or $NoService
	if ($Help) { Write-Host (T 'win_installer_help'); return }

	$CanInteract = -not $env:CI -and [Environment]::UserInteractive -and -not ([Environment]::GetCommandLineArgs() -match '^-noni')
	try { if ([Console]::IsInputRedirected) { $CanInteract = $false } } catch { $CanInteract = $false }
	if ($CanInteract -and -not $Lang -and -not $SavedLang -and -not $Yes -and -not $DryRun) {
		while ($true) {
			$Answer = Read-Host "Language / 語言：1) 繁體中文  2) English  [Enter = $L]"
			if ($Answer -eq "1") { $L = "zh-TW"; break }
			if ($Answer -eq "2") { $L = "en"; break }
			if (-not $Answer) { break }
			Write-Host (T 'invalid_answer')
		}
	}
	$env:STEWARD_LANG = $L
	. Set-ComponentData
	$NodeDownloadUrl = $NodeSource.TrimEnd("/")

	# 安裝來源、版本與元件的偵測只讀既有檔案。
	$IsUpdate = Test-Path (Join-Path $App "REVISION") -PathType Leaf
	$OldVersion = if ($IsUpdate) { (Get-Content (Join-Path $App "REVISION") -Raw -Encoding UTF8).Trim() } else { "" }
	$FromGit = $false
	if ($From) {
		if (-not (Test-Path $From -PathType Container)) { Die (T 'invalid_from' (Display-Path $From)) }
		$From = (Resolve-Path $From).Path
		$FromGit = Test-Path (Join-Path $From ".git")
		$Version = ""
		try {
			$Revision = git -C $From rev-parse --short HEAD 2>$null
			if ($LASTEXITCODE -eq 0) { $Version = "$Revision".Trim() }
		} catch {}
		if (-not $Version) { $Version = "local-$(Get-Date -Format yyyyMMddHHmm)" }
	} else {
		if (-not $Version) {
			try {
				$Version = (Invoke-RestMethod -UseBasicParsing -TimeoutSec 20 -Headers @{ "User-Agent" = "agent-steward" } "https://api.github.com/repos/$Repo/releases/latest").tag_name
			} catch { $Version = "" }
		}
		if (-not $Version) { $Version = "main" }
	}
	$Node = $null
	$NodeSource = "existing"
	$NodeDownloaded = $false
	if (-not $env:STEWARD_FORCE_NODE_DOWNLOAD) {
		foreach ($Candidate in @((Get-Command node -ErrorAction SilentlyContinue).Source, (Join-Path $Root "node\node.exe"))) {
			if (Test-Node $Candidate) { $Node = $Candidate; break }
		}
	}
	$TagFile = Join-Path $Bin "herdr.tag"
	$InstalledHerdrTag = if (Test-Path $TagFile) { (Get-Content $TagFile -Raw -Encoding UTF8).Trim() } else { "" }
	$Ttyd = if (Test-Path $TtydPath -PathType Leaf) { $TtydPath } else { "" }
	$TtydSource = "existing"
	$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$PathParts = @($UserPath -split ";" | Where-Object { $_ })
	$HasLocalBin = $PathParts -contains $LocalBin
	$HasHerdrDir = $PathParts -contains $HerdrDir
	$PathAdded = @()
	$Components = @("herdr", "terminal", "herdr-config", "autostart", "open", "path")
	$Choice = @{ Without = @{}; Inherited = $false; Readd = [bool]$ReaddHerdrKey }
	$WithoutInput = $Without
	if ($IsUpdate -and -not $WithoutExplicit) { $WithoutInput = $InstallReceipt.without; $Choice.Inherited = $true }
	if ($SkipHerdr) { $WithoutInput += ",herdr" }
	if ($NoService) { $WithoutInput += ",autostart,open" }
	if ($NoOpen) { $WithoutInput += ",open" }
	foreach ($Part in ("$WithoutInput" -split ",")) {
		if (-not $Part) { continue }
		if ($Components -cnotcontains $Part) { Die (T 'invalid_component' $Part) }
		$Choice.Without[$Part] = $true
	}
	function Omitted([string]$Id) { return $Choice.Without.ContainsKey($Id) }
	if (Omitted 'herdr') { $Choice.Without["terminal"] = $true; $Choice.Without["herdr-config"] = $true }
	$Port = if ($Settings.server.port) { $Settings.server.port } else { 8791 }
	$TerminalPort = if ($Settings.server.terminalPort) { $Settings.server.terminalPort } else { 8792 }

	function Component-Name($Id) {
		switch ($Id) {
			"herdr" { T 'component_herdr' }
			"terminal" { T 'component_terminal' }
			"herdr-config" { T 'component_herdr_config' }
			"autostart" { T 'component_autostart' }
			"open" { T 'component_open' }
			"path" { T 'win_component_path' }
		}
	}
	function Consequence($Id) {
		switch ($Id) {
			"herdr" { T 'consequence_herdr' }
			"terminal" { T 'consequence_terminal' }
			"herdr-config" { T 'consequence_herdr_config' }
			"autostart" { T 'consequence_autostart' }
			"open" { T 'consequence_open' }
			"path" { T 'win_consequence_path' }
		}
	}
	function Get-Without { return (@($Components | Where-Object { Omitted $_ }) -join ",") }
	function Print-Without {
		$Names = @($Components | Where-Object { Omitted $_ } | ForEach-Object { Component-Name $_ })
		if ($Names.Count) { Write-Host (T 'plan_without' ($Names -join (T 'list_separator'))) }
	}
	function Print-Plan {
		Write-Host ""
		if ($IsUpdate) {
			Write-Host (T 'plan_update_title' $OldVersion $Version)
			$Extra = ""
			if (-not (Omitted 'herdr') -and $InstalledHerdrTag -ne $HerdrTag) { $Extra = T 'update_herdr' $HerdrTag }
			Write-Host (T 'update_downloads' $SizeApp $SizeAppDeps $Extra)
			if (-not (Omitted 'autostart')) { Write-Host (T 'update_restart') }
			if ($Choice.Inherited) { Write-Host (T 'update_keep') } else { Write-Host (T 'update_choices') }
			Print-Without
		} else {
			Write-Host (T 'plan_title' $Version)
			Write-Host ""
			Write-Host (T 'plan_downloads')
			Write-Host (T 'plan_app' $Version $SizeApp $SizeAppDeps)
			if ($From) { Write-Host (T 'plan_local' (Display-Path $From) $Version) }
			if ($Node) { Write-Host (T 'plan_existing' "Node.js" (Display-Path $Node)) } else { Write-Host (T 'plan_node' $NodeVersion $SizeNode) }
			if (-not (Omitted 'herdr')) {
				if ($InstalledHerdrTag -eq $HerdrTag) { Write-Host (T 'plan_herdr_current' $HerdrTag) } else { Write-Host (T 'win_plan_herdr' $HerdrTag $SizeHerdr) }
			}
			if (-not (Omitted 'terminal')) {
				if ($Ttyd) { Write-Host (T 'plan_existing' $TtydName (Display-Path $Ttyd)) } else { Write-Host (T 'win_plan_ttyd' $SizeTtyd) }
			}
			Write-Host ""
			Write-Host (T 'plan_places')
			Write-Host (T 'win_plan_root' (Display-Path $Root))
			Write-Host (T 'plan_steward' (Display-Path (Join-Path $LocalBin "steward.cmd")))
			if (-not (Omitted 'herdr-config')) { Write-Host (T 'win_plan_plugins' (Display-Path $Plug)) }
			if (-not (Omitted 'herdr-config') -or -not (Omitted 'path')) {
				Write-Host (T 'plan_config_header')
				if (-not (Omitted 'herdr-config')) { Write-Host (T 'plan_config' (Display-Path (Join-Path $env:APPDATA "herdr\config.toml"))) }
				if (-not (Omitted 'path')) { Write-Host (T 'win_plan_path' (Display-Path $LocalBin) (Display-Path $HerdrDir)) }
			}
			if (-not (Omitted 'autostart')) {
				Write-Host (T 'win_plan_autostart')
				$Tasks = @("agent-steward")
				if (-not (Omitted 'terminal')) { $Tasks += "agent-steward-terminal" }
				Write-Host (T 'win_plan_task' ($Tasks -join (T 'list_separator')))
			}
			Write-Host (T 'plan_network' "$Port")
			if (-not (Omitted 'terminal')) { Write-Host (T 'plan_network_terminal' "$TerminalPort") }
			Write-Host (T 'plan_access')
			Write-Host (T 'win_plan_wont')
			Write-Host (T 'win_plan_remove' (Display-Path $App))
			Print-Without
		}
		Write-Host ""
	}
	function Customize {
		while ($true) {
			Write-Host (T 'custom_title')
			for ($Index = 0; $Index -lt $Components.Count; $Index++) {
				$Id = $Components[$Index]
				$Mark = if (Omitted $Id) { " " } else { "x" }
				Write-Host (T 'custom_item' $Mark ($Index + 1) (Component-Name $Id) (Consequence $Id))
			}
			$Answer = Read-Host (T 'custom_prompt')
			if (-not $Answer) { return }
			if ($Answer -notmatch '^[1-6]$') { Write-Host (T 'invalid_answer'); continue }
			$Selected = $Components[[int]$Answer - 1]
			$Choice.Inherited = $false
			if (Omitted $Selected) {
				$Choice.Without.Remove($Selected)
				if ($Selected -in @("terminal", "herdr-config")) { $Choice.Without.Remove("herdr") }
				if ($Selected -eq "herdr-config") { $Choice.Readd = $true }
			} else {
				$Choice.Without[$Selected] = $true
				if ($Selected -eq "herdr") {
					$Choice.Without["terminal"] = $true
					$Choice.Without["herdr-config"] = $true
					Write-Host (T 'herdr_disabled')
				}
			}
		}
	}
	function Legacy-UpdateAllowed {
		if (-not $IsUpdate) { return $false }
		try {
			$Stamp = (Get-Content (Join-Path $Root "update.lock") -Raw -Encoding UTF8 -ErrorAction Stop).Trim()
			if ($Stamp -notmatch '^\d+$') { return $false }
			$Age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$Stamp
			return $Age -ge 0 -and $Age -lt 600000
		} catch { return $false }
	}
	while ($true) {
		Print-Plan
		if ($DryRun) { return }
		if ($Yes) { break }
		if (-not $CanInteract) {
			if (Legacy-UpdateAllowed) { break }
			Die (T 'win_no_tty')
		}
		if ($IsUpdate) { $Answer = Read-Host (T 'update_prompt') } else {
			Write-Host (T 'install_choices')
			$Answer = Read-Host (T 'install_prompt')
		}
		if ($IsUpdate) {
			if ($Answer -in @("", "y")) { break }
			if ($Answer -eq "n") { Write-Host (T 'cancelled'); return }
			if ($Answer -eq "c") { Customize; continue }
		} else {
			if ($Answer -in @("", "1")) { break }
			if ($Answer -eq "3") { Write-Host (T 'cancelled'); return }
			if ($Answer -eq "2") { Customize; continue }
		}
		Write-Host (T 'invalid_answer')
	}

	# 使用者確認後才建立目錄與暫存檔。
	$Confirmed = $true
	New-Item -ItemType Directory -Force -Path $Root, $Bin, $LocalBin, $Logs | Out-Null
	$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("agent-steward-" + [guid]::NewGuid().ToString("N"))
	New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

	# ---------- 1. Node.js（22.6 以上） ----------
	if (-not $Node) {
		Say (T 'win_node_download' (Display-Path $Root))
		$NodeArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
		try { $Sums = (Invoke-WebRequest -UseBasicParsing "$NodeDownloadUrl/SHASUMS256.txt").Content } catch { Die (T 'node_connect_failed') }
		$Line = $Sums -split "\r?\n" | Where-Object { ($_ -split "\s+")[1] -like "node-v*-$NodeArch.zip" } | Select-Object -First 1
		if (-not $Line) { Die (T 'node_file_missing') }
		$Want, $File = $Line.Trim() -split "\s+"
		Invoke-WebRequest -UseBasicParsing "$NodeDownloadUrl/$File" -OutFile "$Tmp\node.zip"
		if ((Get-FileHash -Algorithm SHA256 "$Tmp\node.zip").Hash.ToLower() -ne $Want.ToLower()) { Die (T 'node_checksum_failed') }
		Expand-Archive "$Tmp\node.zip" "$Tmp\node"
		Remove-Item -Recurse -Force (Join-Path $Root "node") -ErrorAction SilentlyContinue
		Move-Item (Get-ChildItem "$Tmp\node" | Select-Object -First 1).FullName (Join-Path $Root "node")
		$Node = Join-Path $Root "node\node.exe"
		$NodeSource = "download"
		$NodeDownloaded = $true
	}
	$NodeDir = Split-Path $Node
	$env:Path = "$NodeDir;$env:Path"
	$Npm = Join-Path $NodeDir "npm.cmd"
	if (-not (Test-Path $Npm)) { $Npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
	if (-not $Npm) { Die (T 'npm_missing') }
	Say (T 'node_ready' (& $Node -v) (Display-Path $Node))

	# ---------- 2. 程式先放在 app.new，服務停止後再換上 ----------
	$New = "$App.new"
	Remove-Item -Recurse -Force $New -ErrorAction SilentlyContinue
	if ($From) {
		if ($FromGit) {
			Say (T 'app_from_git' (Display-Path $From))
			git -C $From archive --format=zip -o "$Tmp\app.zip" HEAD
			if ($LASTEXITCODE -ne 0) { Die (T 'win_git_archive_failed') }
			Expand-Archive "$Tmp\app.zip" $New
		} else {
			Say (T 'app_from_dir' (Display-Path $From))
			New-Item -ItemType Directory -Force -Path $New | Out-Null
			Get-ChildItem $From -Force | Where-Object { $_.Name -notin @("node_modules", ".git") } | Copy-Item -Destination $New -Recurse -Force
		}
	} else {
		$Url = if ($Version -eq "main") { "https://codeload.github.com/$Repo/zip/refs/heads/main" } else { "https://codeload.github.com/$Repo/zip/refs/tags/$Version" }
		Say (T 'app_download' $Version)
		try { Invoke-WebRequest -UseBasicParsing $Url -OutFile "$Tmp\app.zip" } catch { Die (T 'download_failed' $Url) }
		Expand-Archive "$Tmp\app.zip" "$Tmp\app"
		Move-Item (Get-ChildItem "$Tmp\app" | Select-Object -First 1).FullName $New
	}
	$Version | Set-Content -Encoding ascii (Join-Path $New "REVISION")
	Say (T 'deps_install')
	Push-Location $New
	try {
		& $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --update-notifier=false | Out-Null
		$NpmExit = $LASTEXITCODE
	} finally { Pop-Location }
	if ($NpmExit -ne 0) { Die (T 'deps_failed') }

	# ---------- 3. 先停背景迴圈，再停這份程式的 Node 與 ttyd ----------
	foreach ($Task in @("agent-steward", "agent-steward-terminal")) {
		if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue }
	}
	$Processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine })
	$Processes | Where-Object { $_.Name -in @("powershell.exe", "pwsh.exe", "conhost.exe") -and $_.CommandLine -like "*$Runner*" } |
		ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	$Processes | Where-Object { ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$App\*") -or ($_.Name -eq "ttyd.exe" -and $_.CommandLine -like "*$Bin\ttyd.exe*") } |
		ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	Start-Sleep -Seconds 1
	if (Test-Path $App) {
		Remove-Item -Recurse -Force "$App.prev" -ErrorAction SilentlyContinue
		Rename-Item $App "app.prev"
	}
	Move-Item $New $App
	Say (T 'app_installed' (Display-Path $App) $Version)

	function Receipt {
		& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\install-receipt.ts") @args
		if ($LASTEXITCODE -ne 0) { Die (T 'receipt_error' "install-receipt.ts ($LASTEXITCODE)") }
	}
	function Set-Receipt($Patch) {
		$Json = $Patch | ConvertTo-Json -Depth 8 -Compress
		$PatchFile = Join-Path $Tmp "receipt.json"
		[IO.File]::WriteAllText($PatchFile, $Json, (New-Object Text.UTF8Encoding $false))
		Receipt set-file $PatchFile
	}
	Receipt change file $App
	if ($NodeDownloaded) { Receipt change file (Join-Path $Root "node") }
	Set-Receipt @{ lang = $L; without = (Get-Without); app = @{ version = $Version }; node = @{ path = $Node; source = $NodeSource } }

	# ---------- 4. herdr ----------
	if (-not (Omitted 'herdr')) {
		$HerdrInfo = Get-Content (Join-Path $App "herdr.json") -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($InstalledHerdrTag -ne $HerdrInfo.tag) {
			$Asset = "herdr-windows-x86_64.zip"
			Say (T 'herdr_download' $HerdrInfo.tag $Asset)
			$HerdrChanged = $false
			try {
				$Base = "https://github.com/$($HerdrInfo.repo)/releases/download/$($HerdrInfo.tag)"
				Invoke-WebRequest -UseBasicParsing "$Base/$Asset" -OutFile "$Tmp\$Asset"
				Invoke-WebRequest -UseBasicParsing "$Base/$Asset.sha256" -OutFile "$Tmp\$Asset.sha256"
				$Want = ((Get-Content "$Tmp\$Asset.sha256" -Raw -Encoding UTF8).Trim() -split "\s+")[0].ToLower()
				if ((Get-FileHash -Algorithm SHA256 "$Tmp\$Asset").Hash.ToLower() -ne $Want) { Die (T 'herdr_checksum_failed') }
				Expand-Archive "$Tmp\$Asset" "$Tmp\herdr"
				try {
					Remove-Item -Recurse -Force $HerdrDir -ErrorAction SilentlyContinue
					$Inner = Get-ChildItem "$Tmp\herdr" -Recurse -Filter herdr.exe | Select-Object -First 1
					Move-Item $Inner.Directory.FullName $HerdrDir
					$HerdrInfo.tag | Set-Content -Encoding ascii $TagFile
					$HerdrChanged = $true
				} catch { Warn (T 'win_herdr_busy') }
			} catch { Warn (T 'herdr_download_failed') }
			if ($HerdrChanged) { Receipt change file $HerdrDir; Receipt change file $TagFile }
		}
	}
	$Herdr = Join-Path $HerdrDir "herdr.exe"
	if (-not (Test-Path $Herdr)) { $Herdr = (Get-Command herdr -ErrorAction SilentlyContinue).Source }

	# ---------- 5. ttyd ----------
	if (-not (Omitted 'terminal') -and -not $Ttyd) {
		Say (T 'ttyd_download')
		try {
			Invoke-WebRequest -UseBasicParsing $TtydSourceWindows -OutFile "$Tmp\ttyd.exe"
			Move-Item "$Tmp\ttyd.exe" $TtydPath -Force
			$Ttyd = $TtydPath
			$TtydSource = "download"
		} catch { Warn (T 'ttyd_missing') }
		if ($Ttyd) { Receipt change file $Ttyd }
	}

	# ---------- 6. steward 指令與使用者 PATH ----------
	$Command = Join-Path $LocalBin "steward.cmd"
	"@echo off`r`n`"$Node`" `"$App\bin\steward.mjs`" %*`r`n" | Set-Content -Encoding ascii $Command
	Receipt change file $Command
	if (-not (Omitted 'path')) {
		if (-not $HasLocalBin) { $PathParts += $LocalBin; $PathAdded += $LocalBin }
		if (-not $HasHerdrDir) { $PathAdded += $HerdrDir }
		if (-not $HasLocalBin -or $PathParts[0] -ne $HerdrDir) {
			$PathParts = @($HerdrDir) + @($PathParts | Where-Object { $_ -ne $HerdrDir })
			[Environment]::SetEnvironmentVariable("Path", ($PathParts -join ";"), "User")
			Set-Receipt @{ pathAdded = @($PathAdded) }
			Say (T 'win_path_added')
		}
	}

	# ---------- 7. herdr 外掛與快捷鍵 ----------
	if (-not (Omitted 'herdr-config')) {
		New-Item -ItemType Directory -Force -Path $Plug | Out-Null
		$NodeToml = $Node.Replace("\", "\\")
		foreach ($Directory in Get-ChildItem (Join-Path $App "herdr-plugins") -Directory) {
			$Destination = Join-Path $Plug $Directory.Name
			New-Item -ItemType Directory -Force -Path $Destination | Out-Null
			Get-ChildItem $Directory.FullName | Where-Object { $_.Name -ne "herdr-plugin.toml" } | Copy-Item -Destination $Destination -Recurse -Force
			$Toml = (Get-Content (Join-Path $Directory.FullName "herdr-plugin.toml") -Raw -Encoding UTF8).Replace('"node"', "`"$NodeToml`"")
			[IO.File]::WriteAllText((Join-Path $Destination "herdr-plugin.toml"), $Toml, (New-Object Text.UTF8Encoding $false))
			Receipt change herdr-plugin $Destination
			if ($Herdr) {
				$Linked = $false
				try { & $Herdr plugin link $Destination 2>&1 | Out-Null; $Linked = $LASTEXITCODE -eq 0 } catch {}
				if (-not $Linked) { Warn (T 'plugin_link_failed' $Directory.Name) }
			}
		}
		$env:STEWARD_NODE = $Node
		$SetupArgs = @()
		if ($Choice.Readd) { $SetupArgs += "--readd" }
		& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\herdr-setup.ts") @SetupArgs
		if ($LASTEXITCODE -ne 0) { Warn (T 'herdr_setup_failed') }
		if ($Herdr) { try { & $Herdr server reload-config 2>&1 | Out-Null } catch {} }
	}

	# ---------- 8. 只更新仍接著的 agent 整合 ----------
	$env:STEWARD_APP_DIR = $App
	& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\refresh-agents.ts")
	if ($LASTEXITCODE -ne 0) { Warn (T 'agents_refresh_failed') }

	# ---------- 9. 登入時自動啟動 ----------
	if (Omitted 'autostart') { Say (T 'service_skipped') } else {
		@'
# 工作排程器執行一個服務；服務停止後，等 10 秒再啟動。
param([string]$Node, [string]$Script, [string]$Log, [string]$WorkDir)
Set-Location $WorkDir
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
	& $Node --experimental-strip-types --no-warnings $Script 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $Log
	Start-Sleep -Seconds 10
}
'@ | Set-Content -Encoding UTF8 $Runner
		Receipt change file $Runner
		function Register-Service($Name, $Script, $Log) {
			$PsArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" -Node `"$Node`" -Script `"$Script`" -Log `"$Log`" -WorkDir `"$App`""
			$Action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless powershell.exe $PsArgs" -WorkingDirectory $App
			$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
			$TaskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
			$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
			Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $TaskSettings -Principal $Principal -Description $AppName -Force | Out-Null
			Receipt change scheduled-task $Name
			Start-ScheduledTask -TaskName $Name
		}
		Register-Service "agent-steward" (Join-Path $App "src\main.ts") (Join-Path $Logs "steward.log")
		if (-not (Omitted 'terminal') -and $Ttyd) { Register-Service "agent-steward-terminal" (Join-Path $App "src\terminal-runner.ts") (Join-Path $Logs "terminal.log") }
	}

	# ---------- 10. 收據、啟動確認與摘要 ----------
	$InstalledHerdrTag = if (Test-Path $TagFile) { (Get-Content $TagFile -Raw -Encoding UTF8).Trim() } else { "" }
	Set-Receipt @{
		lang = $L; without = (Get-Without); app = @{ version = $Version }
		node = @{ path = $Node; source = $NodeSource }
		herdr = @{ tag = $InstalledHerdrTag; symlink = $false }
		ttyd = @{ path = $Ttyd; source = $TtydSource }
		pathAdded = @($PathAdded)
	}
	$Url = "http://127.0.0.1:$Port/"
	if (-not (Omitted 'autostart')) {
		$Ok = $false
		for ($Index = 0; $Index -lt 40; $Index++) {
			try { Invoke-WebRequest -UseBasicParsing "${Url}api/health" -TimeoutSec 2 | Out-Null; $Ok = $true; break } catch { Start-Sleep -Seconds 1 }
		}
		if (-not $Ok) { Die (T 'win_service_failed' (Display-Path $Logs)) }
	}
	Write-Host ""
	Write-Host (T 'summary_done' $Version)
	Write-Host (T 'summary_web' "$Port")
	if (Omitted 'autostart') { Write-Host (T 'win_summary_manual' $App $Node) } else {
		Write-Host (T 'win_summary_service' "agent-steward" "agent-steward")
		if (-not (Omitted 'terminal') -and $Ttyd) { Write-Host (T 'win_summary_service' "agent-steward-terminal" "agent-steward-terminal") }
	}
	Write-Host (T 'win_summary_receipt' (Display-Path $Root))
	Write-Host (T 'win_plan_remove' (Display-Path $App))
	Write-Host (T 'summary_privacy')
	Receipt summary $L
	if (-not (Omitted 'terminal') -and -not $Ttyd) { Warn (T 'ttyd_note_linux') }
	if (-not (Omitted 'open') -and -not (Omitted 'autostart')) {
		Start-Process $Url
		Say (T 'first_use')
	}
} catch {
	Write-Host ((T 'error_prefix') + $_.Exception.Message) -ForegroundColor Red
	$Failed = $true
} finally {
	if ($Tmp) { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
	if ($Confirmed) { Remove-Item -Force (Join-Path $Root "update.lock") -ErrorAction SilentlyContinue }
}
# 直接執行檔案時回報失敗；irm | iex 不關閉視窗，只把 $LASTEXITCODE 設成 1 讓呼叫的程式查得到。
if ($Failed) { $global:LASTEXITCODE = 1; if ($PSCommandPath) { exit 1 } }
} @args
