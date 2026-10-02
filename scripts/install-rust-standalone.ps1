# scripts/install-rust-standalone.ps1
# Standalone Rustup installer for Windows (No winget dependency)

$ErrorActionPreference = "Continue"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Linden Leaf Rust Toolchain Standalone Installer (curl)  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Check if cargo is already installed
$hasCargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($hasCargo) {
    $ver = cargo -V
    Write-Host "[OK] Rust is already installed: $ver" -ForegroundColor Green
    exit 0
}

# 2. Download rustup-init.exe
$tempDir = [System.IO.Path]::GetTempPath()
$rustupExe = Join-Path $tempDir "rustup-init.exe"
$downloadUrl = "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe"

Write-Host "Downloading rustup-init.exe from official mirror..." -ForegroundColor Yellow
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -sSL -o "$rustupExe" "$downloadUrl"
} else {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $rustupExe -UseBasicParsing
}

if (-not (Test-Path $rustupExe)) {
    Write-Error "Failed to download rustup-init.exe. Please check network connection."
    exit 1
}

Write-Host "Configuring USTC mirror for fast reliable download..." -ForegroundColor Yellow
$env:RUSTUP_DIST_SERVER = "https://mirrors.ustc.edu.cn/rust-static"
$env:RUSTUP_UPDATE_ROOT = "https://mirrors.ustc.edu.cn/rust-static/rustup"

Write-Host "Installing Rust toolchain (stable-x86_64-pc-windows-msvc)..." -ForegroundColor Yellow
& "$rustupExe" -y --default-toolchain stable-x86_64-pc-windows-msvc --no-modify-path

# 3. Add Cargo to current process PATH
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
    $env:Path = "$cargoBin;" + $env:Path
    Write-Host "Injected Cargo bin path: $cargoBin" -ForegroundColor Green
}

# 4. Verify
$checkCargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($checkCargo) {
    $ver = cargo -V
    Write-Host "Rust toolchain installed successfully: $ver" -ForegroundColor Green
} else {
    Write-Warning "Installation finished. Please restart your shell and run 'cargo -V'."
}

Write-Host "==========================================================" -ForegroundColor Cyan
