# 專案管家(agent-steward)安裝 / 更新程式:Windows。
#
#   一行安裝(PowerShell):irm https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.ps1 | iex
#   更新:                 設定頁的「檢查更新」,或再跑一次上面那行
#   移除:                 powershell -ExecutionPolicy Bypass -File $HOME\.agent-steward\app\uninstall.ps1
#
# 選項(直接執行檔案時):-From DIR、-Version TAG、-SkipHerdr、-NoOpen、-NoService
# 用 irm | iex 時可以改用環境變數:$env:STEWARD_VERSION = "v0.2.0"
#
# 會放東西的地方:%USERPROFILE%\.agent-steward(程式、設定、資料)、%USERPROFILE%\.local\bin\steward.cmd、
# %APPDATA%\herdr\plugins-local(herdr 外掛)、工作排程器「agent-steward」「agent-steward-terminal」(登入時啟動)。
# 不需要系統管理員權限。
param(
	[string]$From = "",
	[string]$Version = $env:STEWARD_VERSION,
	[switch]$SkipHerdr,
	[switch]$NoOpen,
	[switch]$NoService
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo = if ($env:STEWARD_REPO) { $env:STEWARD_REPO } else { "hao-github-0216/agent-steward" }
$Root = Join-Path $HOME ".agent-steward"
$App = Join-Path $Root "app"
$Bin = Join-Path $Root "bin"
$LocalBin = Join-Path $HOME ".local\bin"
$Logs = Join-Path $Root "logs"
if ($NoService) { $NoOpen = $true }

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "注意:$m" -ForegroundColor Yellow }
# 用 throw 不用 exit:irm | iex 執行時 exit 會把使用者的 PowerShell 視窗整個關掉
function Die($m) { throw $m }
$Failed = $false

New-Item -ItemType Directory -Force -Path $Root, $Bin, $LocalBin, $Logs | Out-Null
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("agent-steward-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

try {
	# ---------- 1. Node.js(22.6 以上) ----------
	function Test-Node($exe) {
		if (-not $exe -or -not (Test-Path $exe)) { return $false }
		try { return ((& $exe -e "const [a,b]=process.versions.node.split('.').map(Number);console.log(a>22||(a===22&&b>=6)?'ok':'old')") -eq "ok") } catch { return $false }
	}
	$Node = $null
	foreach ($c in @((Get-Command node -ErrorAction SilentlyContinue).Source, (Join-Path $Root "node\node.exe"))) {
		if (Test-Node $c) { $Node = $c; break }
	}
	if (-not $Node) {
		Say "下載 Node.js(放在 $Root\node,不需要管理員權限)"
		$na = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
		$base = "https://nodejs.org/dist/latest-v22.x"
		$file = ((Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n" | ForEach-Object { ($_ -split "\s+")[1] } | Where-Object { $_ -like "node-v*-$na.zip" } | Select-Object -First 1)
		if (-not $file) { Die "找不到 Node.js 下載檔" }
		Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile "$Tmp\node.zip"
		Expand-Archive "$Tmp\node.zip" "$Tmp\node"
		Remove-Item -Recurse -Force (Join-Path $Root "node") -ErrorAction SilentlyContinue
		Move-Item (Get-ChildItem "$Tmp\node" | Select-Object -First 1).FullName (Join-Path $Root "node")
		$Node = Join-Path $Root "node\node.exe"
	}
	$NodeDir = Split-Path $Node
	$env:Path = "$NodeDir;$env:Path"
	$Npm = Join-Path $NodeDir "npm.cmd"
	if (-not (Test-Path $Npm)) { $Npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
	if (-not $Npm) { Die "找不到 npm" }
	Say "Node.js $(& $Node -v)($Node)"

	# ---------- 2. 下載 / 準備程式(先放在 app.new,服務停下來後再換上) ----------
	$New = "$App.new"
	Remove-Item -Recurse -Force $New -ErrorAction SilentlyContinue
	if ($From) {
		$From = (Resolve-Path $From).Path
		if (Test-Path (Join-Path $From ".git")) {
			Say "從本機原始碼安裝($From 目前的 commit)"
			git -C $From archive --format=zip -o "$Tmp\app.zip" HEAD
			if ($LASTEXITCODE -ne 0) { Die "git archive 失敗" }
			Expand-Archive "$Tmp\app.zip" $New
			(git -C $From rev-parse --short HEAD) | Set-Content -Encoding ascii (Join-Path $New "REVISION")
		} else {
			Say "從本機資料夾安裝($From)"
			New-Item -ItemType Directory -Force -Path $New | Out-Null
			Get-ChildItem $From -Force | Where-Object { $_.Name -notin @("node_modules", ".git") } | Copy-Item -Destination $New -Recurse -Force
			"local-$(Get-Date -Format yyyyMMddHHmm)" | Set-Content -Encoding ascii (Join-Path $New "REVISION")
		}
	} else {
		if (-not $Version) {
			try { $Version = (Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "agent-steward" } "https://api.github.com/repos/$Repo/releases/latest").tag_name } catch { $Version = "" }
		}
		if ($Version) { $url = "https://codeload.github.com/$Repo/zip/refs/tags/$Version" } else { $Version = "main"; $url = "https://codeload.github.com/$Repo/zip/refs/heads/main" }
		Say "下載專案管家 $Version"
		Invoke-WebRequest -UseBasicParsing $url -OutFile "$Tmp\app.zip"
		Expand-Archive "$Tmp\app.zip" "$Tmp\app"
		Move-Item (Get-ChildItem "$Tmp\app" | Select-Object -First 1).FullName $New
		$Version | Set-Content -Encoding ascii (Join-Path $New "REVISION")
	}
	Say "安裝相依套件"
	Push-Location $New
	& $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --update-notifier=false | Out-Null
	$npmExit = $LASTEXITCODE
	Pop-Location
	if ($npmExit -ne 0) { Die "安裝相依套件失敗" }

	# ---------- 3. 停掉執行中的服務(Windows 不能換掉正在使用的資料夾) ----------
	foreach ($t in @("agent-steward", "agent-steward-terminal")) {
		if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
	}
	# 先停背景迴圈(run-service.ps1),再停管家本身和 ttyd;不會動到正在跑的這支安裝程式
	$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine })
	$procs | Where-Object { $_.Name -in @("powershell.exe", "pwsh.exe", "conhost.exe") -and $_.CommandLine -like "*run-service.ps1*" } |
		ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	$procs | Where-Object { ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$App\*") -or ($_.Name -eq "ttyd.exe" -and $_.CommandLine -like "*$Bin\ttyd.exe*") } |
		ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
	Start-Sleep -Seconds 1

	# 原子替換:舊版留一份 app.prev
	if (Test-Path $App) {
		Remove-Item -Recurse -Force "$App.prev" -ErrorAction SilentlyContinue
		Rename-Item $App "app.prev"
	}
	Move-Item $New $App
	Say "已安裝到 $App($(Get-Content (Join-Path $App 'REVISION')))"

	# ---------- 4. herdr(專案管家用的版本) ----------
	$HerdrDir = Join-Path $Bin "herdr"
	if (-not $SkipHerdr) {
		$hj = Get-Content (Join-Path $App "herdr.json") -Raw | ConvertFrom-Json
		$tagFile = Join-Path $Bin "herdr.tag"
		$have = if (Test-Path $tagFile) { (Get-Content $tagFile -Raw).Trim() } else { "" }
		if ($have -ne $hj.tag) {
			$asset = "herdr-windows-x86_64.zip"
			Say "下載 herdr $($hj.tag)"
			try {
				Invoke-WebRequest -UseBasicParsing "https://github.com/$($hj.repo)/releases/download/$($hj.tag)/$asset" -OutFile "$Tmp\$asset"
				Invoke-WebRequest -UseBasicParsing "https://github.com/$($hj.repo)/releases/download/$($hj.tag)/$asset.sha256" -OutFile "$Tmp\$asset.sha256"
				$want = ((Get-Content "$Tmp\$asset.sha256" -Raw).Trim() -split "\s+")[0].ToLower()
				$got = (Get-FileHash -Algorithm SHA256 "$Tmp\$asset").Hash.ToLower()
				if ($want -ne $got) { Die "herdr 檔案驗證失敗(sha256 不符)" }
				Expand-Archive "$Tmp\$asset" "$Tmp\herdr"
				try {
					Remove-Item -Recurse -Force $HerdrDir -ErrorAction SilentlyContinue
					$inner = Get-ChildItem "$Tmp\herdr" -Recurse -Filter herdr.exe | Select-Object -First 1
					Move-Item $inner.Directory.FullName $HerdrDir
					$hj.tag | Set-Content -Encoding ascii $tagFile
				} catch {
					Warn "herdr 正在執行,沒辦法換新版:關掉所有 herdr 視窗後再跑一次安裝"
				}
			} catch {
				Warn "下載 herdr 失敗:終端機、自動記錄、派工會先無法使用(之後再跑一次安裝即可)"
			}
		}
	}
	$Herdr = Join-Path $HerdrDir "herdr.exe"
	if (-not (Test-Path $Herdr)) { $Herdr = (Get-Command herdr -ErrorAction SilentlyContinue).Source }

	# ---------- 5. ttyd(網頁終端機) ----------
	$Ttyd = Join-Path $Bin "ttyd.exe"
	if (-not (Test-Path $Ttyd)) {
		Say "下載 ttyd"
		try { Invoke-WebRequest -UseBasicParsing "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.win32.exe" -OutFile $Ttyd }
		catch { Warn "下載 ttyd 失敗:網頁終端機無法使用"; $Ttyd = $null }
	}

	# ---------- 6. steward 指令、PATH ----------
	"@echo off`r`n`"$Node`" `"$App\bin\steward.mjs`" %*`r`n" | Set-Content -Encoding ascii (Join-Path $LocalBin "steward.cmd")
	$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
	$parts = @($userPath -split ";" | Where-Object { $_ })
	$changed = $false
	foreach ($p in @($LocalBin, $HerdrDir)) { if ($parts -notcontains $p) { $parts += $p; $changed = $true } }
	if ($changed) {
		[Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
		Say "已把 $LocalBin 和 herdr 加進 PATH(新開的終端機才會生效)"
	}

	# ---------- 7. herdr 外掛 ----------
	$Plug = Join-Path $env:APPDATA "herdr\plugins-local"
	New-Item -ItemType Directory -Force -Path $Plug | Out-Null
	$NodeToml = $Node.Replace("\", "\\")
	foreach ($d in Get-ChildItem (Join-Path $App "herdr-plugins") -Directory) {
		$dest = Join-Path $Plug $d.Name
		# 原地覆蓋檔案,不要先刪資料夾:herdr 看到資料夾消失會把外掛註銷
		New-Item -ItemType Directory -Force -Path $dest | Out-Null
		Get-ChildItem $d.FullName | Where-Object { $_.Name -ne "herdr-plugin.toml" } | Copy-Item -Destination $dest -Recurse -Force
		$toml = (Get-Content (Join-Path $d.FullName "herdr-plugin.toml") -Raw -Encoding UTF8).Replace('"node"', "`"$NodeToml`"")
		[IO.File]::WriteAllText((Join-Path $dest "herdr-plugin.toml"), $toml, (New-Object Text.UTF8Encoding $false))
		if ($Herdr) {
			& $Herdr plugin link $dest *> $null
			if ($LASTEXITCODE -ne 0) { Warn "herdr 外掛 $($d.Name) 沒有接上(herdr 還沒啟動過?之後再跑一次安裝即可)" }
		}
	}

	# ---------- 8. 已經接上專案管家的 agent:更新路徑 ----------
	$env:STEWARD_APP_DIR = $App
	& $Node --experimental-strip-types --no-warnings (Join-Path $App "src\refresh-agents.ts")
	if ($LASTEXITCODE -ne 0) { Warn "更新 agent 整合失敗" }

	# ---------- 9. 登入時自動啟動(工作排程器,不需要管理員) ----------
	if ($NoService) { Say "略過自動啟動(-NoService)"; return }
	$runner = Join-Path $Root "run-service.ps1"
	@'
# 工作排程器執行這支:跑管家的一個服務,掛掉 10 秒後自動重開(安裝程式產生,不要手動改)
param([string]$Node, [string]$Script, [string]$Log, [string]$WorkDir)
Set-Location $WorkDir
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
	& $Node --experimental-strip-types --no-warnings $Script 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $Log
	Start-Sleep -Seconds 10
}
'@ | Set-Content -Encoding UTF8 $runner
	function Register-Service($name, $script, $log) {
		$psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`" -Node `"$Node`" -Script `"$script`" -Log `"$log`" -WorkDir `"$App`""
		# conhost --headless:不開任何視窗
		$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless powershell.exe $psArgs" -WorkingDirectory $App
		$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
		$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
		$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
		Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "專案管家(agent-steward)" -Force | Out-Null
		Start-ScheduledTask -TaskName $name
	}
	Register-Service "agent-steward" (Join-Path $App "src\main.ts") (Join-Path $Logs "steward.log")
	if ($Ttyd) { Register-Service "agent-steward-terminal" (Join-Path $App "src\terminal-runner.ts") (Join-Path $Logs "terminal.log") }

	# ---------- 10. 確認啟動 ----------
	$port = 8791
	try { $s = Get-Content (Join-Path $Root "settings.json") -Raw | ConvertFrom-Json; if ($s.server.port) { $port = $s.server.port } } catch {}
	$url = "http://127.0.0.1:$port/"
	$ok = $false
	for ($i = 0; $i -lt 40; $i++) {
		try { Invoke-WebRequest -UseBasicParsing "${url}api/health" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 1 }
	}
	if (-not $ok) { Die "專案管家沒有啟動起來,看 $Logs\steward.log" }
	Say "專案管家已經在跑:$url"
	if (-not $NoOpen) {
		Start-Process $url
		Say "第一次使用:在瀏覽器裡設定管理密碼、AI 接口和要接上的 agent"
	}
} catch {
	Write-Host "錯誤:$($_.Exception.Message)" -ForegroundColor Red
	$Failed = $true
} finally {
	Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
	Remove-Item -Force (Join-Path $Root "update.lock") -ErrorAction SilentlyContinue
}
# 直接執行檔案(一鍵更新)時回報失敗;irm | iex 時不 exit,以免關掉視窗
if ($Failed -and $PSCommandPath) { exit 1 }
