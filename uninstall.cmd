@echo off
chcp 65001 >nul
setlocal EnableExtensions

title AGY 控制台 (agy-monitor) 一键卸载
echo.
echo ========================================================
echo    AGY 控制台 (agy-monitor) Windows 一键卸载器
echo ========================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node "%~dp0scripts\uninstall.mjs" %*
) else (
  set "TARGET=%USERPROFILE%\.gemini\config\plugins\agy-monitor"
  if exist "%TARGET%" (
    rmdir /s /q "%TARGET%"
    echo [完成] 已移除插件目录：%TARGET%
  ) else (
    echo [提示] 未检测到已安装的插件目录：%TARGET%
  )
)

echo.
pause
exit /b 0
