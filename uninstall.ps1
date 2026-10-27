# 移除專案管家(Windows)。
#   powershell -ExecutionPolicy Bypass -File $HOME\.agent-steward\app\uninstall.ps1          移除程式與服務,保留資料
#   powershell -ExecutionPolicy Bypass -File $HOME\.agent-steward\app\uninstall.ps1 -Purge   連資料一起刪掉
# 各 agent 的整合(hook、MCP、AGENTS.md 段落)會先拿掉;herdr 的設定不會動。
param([switch]$Purge)
$ErrorActionPreference = "Continue"
$Root = Join-Path $HOME ".agent-steward"
$App = Join-Path $Root "app"
$Bin = Join-Path $Root "bin"
$LocalBin = Join-Path $HOME ".local\bin"
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# 1. 先拿掉各 agent 的整合(趁程式還在)
$Node = $null
$cmd = Join-Path $LocalBin "steward.cmd"
if (Test-Path $cmd) { $m = [regex]::Match((Get-Content $cmd -Raw), '"([^"]+node\.exe)"'); if ($m.Success) { $Node = $m.Groups[1].Value } }
if (-not $Node -or -not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if ($Node -and (Test-Path (Join-Path $App "src\refresh-agents.ts"))) {
	Say "拿掉各 agent 的專案管家整合"
	$env:STEWARD_APP_DIR = $App
	& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\refresh-agents.ts") --remove-all
}

# 2. 停掉並刪除排程工作、結束還在跑的程序
foreach ($t in @("agent-steward", "agent-steward-terminal")) {
	if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
		Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
		Unregister-ScheduledTask -TaskName $t -Confirm:$false
	}
}
$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine })
$procs | Where-Object { $_.Name -in @("powershell.exe", "pwsh.exe", "conhost.exe") -and $_.CommandLine -like "*run-service.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$procs | Where-Object { ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$App\*") -or ($_.Name -eq "ttyd.exe" -and $_.CommandLine -like "*$Bin\ttyd.exe*") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Say "已停止服務"

# 3. herdr 外掛、steward 指令、PATH
$Herdr = Join-Path $Bin "herdr\herdr.exe"
if (-not (Test-Path $Herdr)) { $Herdr = (Get-Command herdr -ErrorAction SilentlyContinue).Source }
if ($Herdr) { foreach ($p in @("local.current-space-agents", "local.folder-nav")) { & $Herdr plugin unlink $p *> $null } }
$Plug = Join-Path $env:APPDATA "herdr\plugins-local"
Remove-Item -Recurse -Force (Join-Path $Plug "current-space-agents"), (Join-Path $Plug "folder-nav") -ErrorAction SilentlyContinue
Remove-Item -Force $cmd -ErrorAction SilentlyContinue
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$keep = @($userPath -split ";" | Where-Object { $_ -and $_ -ne (Join-Path $Bin "herdr") })
[Environment]::SetEnvironmentVariable("Path", ($keep -join ";"), "User")

# 4. 程式 / 資料
Start-Sleep -Seconds 1
if ($Purge) {
	Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
	Say "已刪除 $Root(含所有資料)"
} else {
	foreach ($d in @($App, "$App.prev", (Join-Path $Root "node"), $Bin, (Join-Path $Root "update"), (Join-Path $Root "run-service.ps1"))) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue }
	Say "已移除程式;資料留在 $Root(要全部刪掉:Remove-Item -Recurse -Force $Root)"
}
