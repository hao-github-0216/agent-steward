# 移除專案管家（Windows）；加 -Purge 會連資料一起刪掉。
# 有 install.json 時，只移除收據記錄的工作排程、PATH 項目與外掛。
param([switch]$Purge, [string]$Lang = $env:STEWARD_LANG)
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
  --skip-herdr     不下載 herdr，沿用你自己編的版本
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
		'plan_herdr_skipped' = '  herdr：不下載，沿用你自己的 herdr（--skip-herdr）'
		'win_plan_herdr_skipped' = '  herdr：不下載，沿用你自己的 herdr（-SkipHerdr）'
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
  -SkipHerdr         不下載 herdr，沿用你自己編的版本
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
  --skip-herdr     Don''t download herdr; use your own build
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
		'plan_herdr_skipped' = '  herdr: not downloaded; using your own herdr (--skip-herdr)'
		'win_plan_herdr_skipped' = '  herdr: not downloaded; using your own herdr (-SkipHerdr)'
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
  -SkipHerdr         Don''t download herdr; use your own build
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

$ErrorActionPreference = "Continue"
$Root = Join-Path $HOME ".agent-steward"
$App = Join-Path $Root "app"
$Bin = Join-Path $Root "bin"
$LocalBin = Join-Path $HOME ".local\bin"
$Runner = Join-Path $Root "run-service.ps1"
$ReceiptPath = Join-Path $Root "install.json"
$L = if ((Get-UICulture).Name -like "zh*") { "zh-TW" } else { "en" }
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
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
$HasReceipt = Test-Path $ReceiptPath -PathType Leaf
$InstallReceipt = Read-Json $ReceiptPath
$Settings = Read-Json (Join-Path $Root "settings.json")
$SavedLang = Normalize-Language $Settings.ui.lang
if (-not $SavedLang) { $SavedLang = Normalize-Language $InstallReceipt.lang }
if (-not $SavedLang -and (Test-Path (Join-Path $App "REVISION") -PathType Leaf)) { $SavedLang = "zh-TW" }
if ($SavedLang) { $L = $SavedLang }
if ($Lang) {
	$ChosenLang = Normalize-Language $Lang
	if (-not $ChosenLang) { throw (T 'invalid_lang' $Lang) }
	$L = $ChosenLang
}
$env:STEWARD_LANG = $L

# 1. 程式還在時，拿掉 agent 整合與安裝程式加上的 herdr 快捷鍵。
$Node = $InstallReceipt.node.path
$Command = Join-Path $LocalBin "steward.cmd"
if (-not $Node -or -not (Test-Path $Node)) {
	$Node = $null
	if (Test-Path $Command) {
		$Match = [regex]::Match((Get-Content $Command -Raw -Encoding UTF8), '"([^"]+node\.exe)"')
		if ($Match.Success) { $Node = $Match.Groups[1].Value }
	}
}
if (-not $Node -or -not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$CanReadReceipt = $Node -and $HasReceipt -and (Test-Path (Join-Path $App "src\install-receipt.ts"))
function Receipt { & $Node --experimental-strip-types --no-warnings (Join-Path $App "src\install-receipt.ts") @args }
function Recorded($Type, $Path) {
	if (-not $HasReceipt) { return $true }
	return (@($InstallReceipt.changes | Where-Object { $_.type -eq $Type -and $_.path -eq $Path }).Count -gt 0)
}
if ($Node -and (Test-Path (Join-Path $App "src\refresh-agents.ts"))) {
	Say (T 'uninstall_agents')
	$env:STEWARD_APP_DIR = $App
	& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\refresh-agents.ts") --remove-all
}
if ($Node -and (Test-Path (Join-Path $App "src\tailscale.ts"))) {
	& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\tailscale.ts") --serve-off
}
if ($Node -and (Test-Path (Join-Path $App "src\herdr-setup.ts")) -and (-not $HasReceipt -or $InstallReceipt.herdrKeyAdded -eq $true)) {
	& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\herdr-setup.ts") --remove
}

# 2. 有收據時只停止並刪除收據記錄的排程工作。
$Tasks = if ($HasReceipt) {
	@($InstallReceipt.changes | Where-Object { $_.type -eq "scheduled-task" } | ForEach-Object { $_.path } | Select-Object -Unique)
} else { @("agent-steward", "agent-steward-terminal") }
foreach ($Task in $Tasks) {
	if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
		Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
		Unregister-ScheduledTask -TaskName $Task -Confirm:$false
	}
}
$Processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine })
$Processes | Where-Object { $_.Name -in @("powershell.exe", "pwsh.exe", "conhost.exe") -and $_.CommandLine -like "*$Runner*" } |
	ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$Processes | Where-Object { ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$App\*") -or ($_.Name -eq "ttyd.exe" -and $_.CommandLine -like "*$Bin\ttyd.exe*") } |
	ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Say (T 'uninstall_stopped')

# 3. 外掛、steward 指令與這次安裝新增的 PATH 項目。
$Herdr = Join-Path $Bin "herdr\herdr.exe"
if (-not (Test-Path $Herdr)) { $Herdr = (Get-Command herdr -ErrorAction SilentlyContinue).Source }
$Plug = Join-Path $env:APPDATA "herdr\plugins-local"
foreach ($Name in @("current-space-agents", "folder-nav")) {
	$Destination = Join-Path $Plug $Name
	if (Recorded "herdr-plugin" $Destination) {
		if ($Herdr) { & $Herdr plugin unlink "local.$Name" *> $null }
		Remove-Item -Recurse -Force $Destination -ErrorAction SilentlyContinue
	}
}
if (Recorded "file" $Command) { Remove-Item -Force $Command -ErrorAction SilentlyContinue }
$RemovePaths = if ($HasReceipt) { @($InstallReceipt.pathAdded) } else { @(Join-Path $Bin "herdr") }
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$Parts = @($UserPath -split ";" | Where-Object { $_ })
$Keep = @($Parts | Where-Object { $RemovePaths -notcontains $_ })
if ($Keep.Count -ne $Parts.Count) {
	[Environment]::SetEnvironmentVariable("Path", ($Keep -join ";"), "User")
	foreach ($Path in $RemovePaths) {
		if ($Parts -contains $Path) { Write-Host (T 'win_path_removed' (Display-Path $Path)) }
	}
}

# 備份與收據清單要在刪除程式之前印出。
if ($CanReadReceipt) {
	Receipt summary $L uninstall_receipt_header
	$Backups = @((Read-Json $ReceiptPath).backups)
	if ($Backups.Count) {
		Write-Host (T 'uninstall_backups')
		foreach ($Backup in $Backups) { Write-Host ("  " + (Display-Path $Backup)) }
	}
}

# 4. 程式與資料。
Start-Sleep -Seconds 1
if ($Purge) {
	Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
	Say (T 'uninstall_purged' (Display-Path $Root))
} else {
	foreach ($Directory in @($App, "$App.prev", (Join-Path $Root "node"), $Bin, (Join-Path $Root "update"), $Runner)) {
		Remove-Item -Recurse -Force $Directory -ErrorAction SilentlyContinue
	}
	Say (T 'win_uninstall_kept' (Display-Path $Root) $Root)
}
