# agent-steward installer for Windows (bootstrap).
#
#   irm https://raw.githubusercontent.com/hao-github-0216/agent-steward/main/install.ps1 | iex
#
# This file is ASCII only on purpose: Windows PowerShell 5.1 does not decode `irm` output as UTF-8,
# so any non-ASCII text here would be garbled (some garbled bytes even act as line breaks).
# It downloads the real installer (scripts/install-windows.ps1, UTF-8) as bytes, decodes it as UTF-8 and runs it.
# Options when running this file directly: -From DIR -Version TAG -SkipHerdr -NoOpen -NoService
# With irm | iex use environment variables instead: STEWARD_FROM, STEWARD_VERSION, STEWARD_SKIP_HERDR,
# STEWARD_NO_OPEN, STEWARD_NO_SERVICE (and STEWARD_REF to pick the branch/tag the installer comes from).
& {
	$ErrorActionPreference = "Stop"
	try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
	$local = if ($PSScriptRoot) { Join-Path $PSScriptRoot "scripts\install-windows.ps1" } else { "" }
	if ($local -and (Test-Path $local)) {
		$bytes = [IO.File]::ReadAllBytes($local)
	} else {
		$repo = if ($env:STEWARD_REPO) { $env:STEWARD_REPO } else { "hao-github-0216/agent-steward" }
		$ref = if ($env:STEWARD_REF) { $env:STEWARD_REF } else { "main" }
		$bytes = (New-Object Net.WebClient).DownloadData("https://raw.githubusercontent.com/$repo/$ref/scripts/install-windows.ps1")
	}
	$text = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)
	& ([scriptblock]::Create($text)) @args
} @args
