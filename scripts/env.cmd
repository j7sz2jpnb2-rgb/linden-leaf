@echo off
rem scripts/env.cmd - Portable CMD environment wrapper for Linden Leaf.
rem Optional overrides: LINDEN_TOOLCHAINS_DIR (or LINDEN_TOOLCHAIN_ROOT), LINDEN_DEV_ROOT, LINDEN_BUILD_ROOT, MUPDF_ROOT

for %%I in ("%~dp0..") do set "LINDEN_PROJECT_ROOT=%%~fI"
for %%I in ("%LINDEN_PROJECT_ROOT%\..") do set "LINDEN_PARENT_ROOT=%%~fI"

if "%LINDEN_TOOLCHAINS_DIR%"=="" if not "%LINDEN_TOOLCHAIN_ROOT%"=="" set "LINDEN_TOOLCHAINS_DIR=%LINDEN_TOOLCHAIN_ROOT%"
if "%LINDEN_DEV_ROOT%"=="" set "LINDEN_DEV_ROOT=%LINDEN_PARENT_ROOT%"
if "%LINDEN_BUILD_ROOT%"=="" set "LINDEN_BUILD_ROOT=%LINDEN_PROJECT_ROOT%\.local\build"
if "%CARGO_TARGET_DIR%"=="" set "CARGO_TARGET_DIR=%LINDEN_BUILD_ROOT%\target"

if not "%LINDEN_TOOLCHAINS_DIR%"=="" (
    if exist "%LINDEN_TOOLCHAINS_DIR%\cargo\bin" set "PATH=%LINDEN_TOOLCHAINS_DIR%\cargo\bin;%PATH%"
    if "%CARGO_HOME%"=="" if exist "%LINDEN_TOOLCHAINS_DIR%\cargo" set "CARGO_HOME=%LINDEN_TOOLCHAINS_DIR%\cargo"
    if "%RUSTUP_HOME%"=="" if exist "%LINDEN_TOOLCHAINS_DIR%\rustup" set "RUSTUP_HOME=%LINDEN_TOOLCHAINS_DIR%\rustup"
)

if "%MUPDF_ROOT%"=="" set "MUPDF_ROOT=%LINDEN_DEV_ROOT%\mupdf-1.25.4-source"
if "%LL_MUPDF_INCLUDE%"=="" if exist "%MUPDF_ROOT%\include" set "LL_MUPDF_INCLUDE=%MUPDF_ROOT%\include"
if "%LL_MUPDF_LIB_DIR%"=="" if exist "%MUPDF_ROOT%\platform\win32\x64\Release" set "LL_MUPDF_LIB_DIR=%MUPDF_ROOT%\platform\win32\x64\Release"
if "%LL_MUPDF_LIBS%"=="" set "LL_MUPDF_LIBS=libmupdf;libthirdparty;libresources"
if "%LL_REQUIRE_NATIVE_MUPDF%"=="" if not "%LL_MUPDF_INCLUDE%"=="" if not "%LL_MUPDF_LIB_DIR%"=="" set "LL_REQUIRE_NATIVE_MUPDF=1"

rem Discover MSVC + MSBuild via vswhere if available on standard Windows host
set "LINDEN_PF86=%ProgramFiles(x86)%"
set "LINDEN_VSWHERE=%LINDEN_PF86%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%LINDEN_VSWHERE%" (
    for /f "usebackq delims=" %%V in (`"%LINDEN_VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "LINDEN_VS_ROOT=%%V"
    for /f "usebackq delims=" %%M in (`"%LINDEN_VSWHERE%" -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" 2^>nul`) do set "LINDEN_MSBUILD_EXE=%%M"
)
if not "%LINDEN_MSBUILD_EXE%"=="" for %%D in ("%LINDEN_MSBUILD_EXE%") do set "PATH=%%~dpD;%PATH%"
if not "%LINDEN_VS_ROOT%"=="" if exist "%LINDEN_VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" (
    call "%LINDEN_VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
)

echo [env.cmd] Environment configured (project=%LINDEN_PROJECT_ROOT%).
if "%~1"=="" (
    git --version
    node --version
    cargo --version
) else (
    %*
)
