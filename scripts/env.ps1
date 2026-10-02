# scripts/env.ps1
# Project-level environment configuration for Linden Leaf (PowerShell)
# Configures PATH, INCLUDE, LIB, and environment variables for the current session without modifying global system environment.

$projectRoot = Split-Path -Parent $PSScriptRoot

# Configure PATH with discovered local toolchains (Git, Node, PNPM, Cargo)
$toolPaths = @(
    "D:\LindenLeaf-Toolchains\cargo\bin",
    "C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd",
    "C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin",
    "C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback"
)

# Deterministic MSVC v143 Toolset (14.44.35207) and Windows 11 SDK (10.0.22621.0)
$msvcToolsetDir = "D:\LindenLeaf-Toolchains\MSVC\VC\Tools\MSVC\14.44.35207"
$windowsSdkDir = "C:\Program Files (x86)\Windows Kits\10"
$windowsSdkVersion = "10.0.22621.0"
$msbuildBin = "D:\LindenLeaf-Toolchains\MSVC\MSBuild\Current\Bin"

if (Test-Path $msvcToolsetDir) {
    $toolPaths += "$msvcToolsetDir\bin\Hostx64\x64"
}
if (Test-Path "$windowsSdkDir\bin\$windowsSdkVersion\x64") {
    $toolPaths += "$windowsSdkDir\bin\$windowsSdkVersion\x64"
}
if (Test-Path $msbuildBin) {
    $toolPaths += $msbuildBin
}

foreach ($tp in $toolPaths) {
    if ((Test-Path $tp) -and ($env:PATH -notlike "*$tp*")) {
        $env:PATH = "$tp;" + $env:PATH
    }
}

# Set INCLUDE, LIB, and LIBPATH for MSVC x64 C/C++ compilation
$includePaths = @(
    "$msvcToolsetDir\include",
    "$windowsSdkDir\Include\$windowsSdkVersion\ucrt",
    "$windowsSdkDir\Include\$windowsSdkVersion\shared",
    "$windowsSdkDir\Include\$windowsSdkVersion\um",
    "$windowsSdkDir\Include\$windowsSdkVersion\winrt",
    "$windowsSdkDir\Include\$windowsSdkVersion\cppwinrt"
)
$env:INCLUDE = ($includePaths | Where-Object { Test-Path $_ }) -join ";"

$libPaths = @(
    "$msvcToolsetDir\lib\x64",
    "$windowsSdkDir\Lib\$windowsSdkVersion\ucrt\x64",
    "$windowsSdkDir\Lib\$windowsSdkVersion\um\x64"
)
$env:LIB = ($libPaths | Where-Object { Test-Path $_ }) -join ";"
$env:LIBPATH = "$msvcToolsetDir\lib\x64"

# Project caches and toolchains on D: drive
$env:PNPM_HOME = "D:\LindenLeaf-Dev\.pnpm-store"
$env:RUSTUP_HOME = "D:\LindenLeaf-Toolchains\rustup"
$env:CARGO_HOME = "D:\LindenLeaf-Toolchains\cargo"
$env:CARGO_TARGET_DIR = "D:\LindenLeaf-Build\target"
$env:LINDEN_NATIVE_CACHE_DIR = "D:\LindenLeaf-Data\development\pdf-native"

# MuPDF native bridge configuration (MuPDF 1.25.4)
$mupdfInclude = "D:\LindenLeaf-Dev\mupdf-1.25.4-source\include"
$mupdfLibDir = "D:\LindenLeaf-Dev\mupdf-1.25.4-source\platform\win32\x64\Release"
if (Test-Path $mupdfInclude) {
    $env:LL_MUPDF_INCLUDE = $mupdfInclude
}
if (Test-Path $mupdfLibDir) {
    $env:LL_MUPDF_LIB_DIR = $mupdfLibDir
}
$env:LL_MUPDF_LIBS = "libmupdf;libthirdparty;libresources"
$env:LL_REQUIRE_NATIVE_MUPDF = "1"

Write-Host "[env.ps1] Project session environment configured." -ForegroundColor Green
Write-Host "  Project root: $projectRoot"
Write-Host "  Git: $(Get-Command git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Node: $(Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  PNPM: $(Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Rustc: $(Get-Command rustc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Cargo: $(Get-Command cargo -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Linker: $(Get-Command link -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  MSBuild: $(Get-Command msbuild -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  MSVC Toolset: $msvcToolsetDir"
Write-Host "  Windows SDK: $windowsSdkDir ($windowsSdkVersion)"
Write-Host "  MuPDF Include: $env:LL_MUPDF_INCLUDE"
Write-Host "  MuPDF Lib Dir: $env:LL_MUPDF_LIB_DIR"
Write-Host "  MuPDF Libs: $env:LL_MUPDF_LIBS"
Write-Host "  Require Native: $env:LL_REQUIRE_NATIVE_MUPDF"
