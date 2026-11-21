@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

title AGY 控制台 (agy-monitor) 一键安装
echo.
echo ========================================================
echo    AGY 控制台 (agy-monitor) Windows 一键安装器
echo ========================================================
echo.

set "NODE_OK=0"
where node >nul 2>nul
if !ERRORLEVEL! EQU 0 (
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)" >nul 2>nul
  if !ERRORLEVEL! EQU 0 set "NODE_OK=1"
)

if "!NODE_OK!"=="0" (
  echo [提示] 检测到当前未安装 Node.js 或版本低于 v22.5.0。
  echo.
  where winget >nul 2>nul
  if !ERRORLEVEL! EQU 0 (
    choice /C YN /M "是否立即通过 Windows 自带 winget 自动安装最新 Node.js LTS？"
    if !ERRORLEVEL! EQU 1 (
      echo.
      echo 正在安装 Node.js LTS，请稍候...
      winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
      set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs;!PATH!"
    ) else (
      echo.
      echo 请手动前往 https://nodejs.org 下载安装 Node.js LTS 后，再次双击本文件即可。
      echo.
      pause
      exit /b 1
    )
  ) else (
    echo 请先前往 https://nodejs.org 下载并安装 Node.js v22.5+ ^(LTS^)，然后重新双击本文件。
    echo.
    pause
    exit /b 1
  )
)

node "%~dp0scripts\install.mjs" %*
set "EXIT_CODE=!ERRORLEVEL!"

if !EXIT_CODE! NEQ 0 (
  echo.
  echo [失败] 安装过程中出现错误（退出码 !EXIT_CODE!）。
)

echo.
pause
exit /b !EXIT_CODE!
