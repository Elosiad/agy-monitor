@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

title AGY 控制台 (agy-monitor) 一键卸载
echo.
echo ========================================================
echo    AGY 控制台 (agy-monitor) Windows 一键卸载器
echo ========================================================
echo.

set "EXIT_CODE=0"
where node >nul 2>nul
if !ERRORLEVEL! EQU 0 (
  node "%~dp0scripts\uninstall.mjs" %*
  set "EXIT_CODE=!ERRORLEVEL!"
) else (
  set "BACKDROP_EXE=%USERPROFILE%\.gemini\antigravity\plugin_data\agy-monitor\bin\agy_backdrop.exe"
  if exist "!BACKDROP_EXE!" (
    "!BACKDROP_EXE!" --stop >nul 2>nul
  )
  set "PET_EXE=%USERPROFILE%\.gemini\antigravity\plugin_data\agy-monitor\bin\agy_desktop_pet.exe"
  if exist "!PET_EXE!" (
    "!PET_EXE!" --stop >nul 2>nul
  )
  set "TARGET=%USERPROFILE%\.gemini\config\plugins\agy-monitor"
  if exist "!TARGET!" (
    rmdir /s /q "!TARGET!"
    set "EXIT_CODE=!ERRORLEVEL!"
    if !EXIT_CODE! EQU 0 (
      echo [完成] 已移除插件目录：!TARGET!
    ) else (
      echo [失败] 移除插件目录失败：!TARGET!
    )
  ) else (
    echo [提示] 未检测到已安装的插件目录：!TARGET!
  )
)

echo.
pause
exit /b !EXIT_CODE!
