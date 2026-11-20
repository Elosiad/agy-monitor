#Requires -Version 5.1
<#
.SYNOPSIS
  AGY Console (agy-monitor) one-liner installer for Windows PowerShell.
.EXAMPLE
  # Local run:
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1

  # Remote one-liner:
  irm "https://raw.githubusercontent.com/aishadiaodeqishui/agy-monitor/main/scripts/install.ps1" | iex
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Test-NodeReady {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  try {
    & node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

if (-not (Test-NodeReady)) {
  Write-Host "[提示] 未检测到 Node.js >= 22.5.0。" -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "正在尝试通过 winget 自动安装 Node.js LTS..." -ForegroundColor Cyan
    & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:Path = "$env:ProgramFiles\nodejs;$env:LOCALAPPDATA\Programs\nodejs;$env:Path"
  }
  if (-not (Test-NodeReady)) {
    throw "请先安装 Node.js >= 22.5.0 (https://nodejs.org) 后重新运行。"
  }
}

# Local repository mode
$localRoot = $null
if ($PSScriptRoot) {
  $candidate = Split-Path -Parent $PSScriptRoot
  if (Test-Path (Join-Path $candidate 'plugin.json')) {
    $localRoot = $candidate
  }
}

if ($localRoot) {
  & node (Join-Path $localRoot 'scripts\install.mjs')
  exit $LASTEXITCODE
}

# Remote irm | iex mode
$repo = if ($env:AGY_MONITOR_REPO) { $env:AGY_MONITOR_REPO } else { 'aishadiaodeqishui/agy-monitor' }
$branch = if ($env:AGY_MONITOR_BRANCH) { $env:AGY_MONITOR_BRANCH } else { 'main' }

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-monitor-install-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
  $zipPath = Join-Path $tmpDir 'repo.zip'
  $zipUrl = "https://github.com/$repo/archive/refs/heads/$branch.zip"
  Write-Host "正在下载 AGY 控制台源码包：$zipUrl" -ForegroundColor Cyan
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

  $extracted = Get-ChildItem -Path $tmpDir -Directory | Select-Object -First 1
  if (-not $extracted -or -not (Test-Path (Join-Path $extracted.FullName 'scripts\install.mjs'))) {
    throw '解压后未找到 scripts\install.mjs。'
  }
  & node (Join-Path $extracted.FullName 'scripts\install.mjs')
  exit $LASTEXITCODE
} finally {
  Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
