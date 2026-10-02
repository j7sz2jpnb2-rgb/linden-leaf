# scripts/finish-toolchain-and-init.ps1
# Completes Android NDK extraction, installs SDK platforms/build-tools, and initializes Tauri Android shell
$ErrorActionPreference = "Stop"

$baseDir = "D:\LindenLeaf-Toolchains\Android"
$downloadsDir = Join-Path $baseDir "downloads"
$jdkDir = Join-Path $baseDir "jdk"
$sdkDir = Join-Path $baseDir "sdk"
$cmdlineLatestDir = Join-Path $sdkDir "cmdline-tools\latest"
$ndkTargetDir = Join-Path $sdkDir "ndk\26.3.11579264"
$ndkZip = Join-Path $downloadsDir "android-ndk-r26d-windows.zip"

Write-Host "=== Linden Leaf Finish Toolchain & Init ===" -ForegroundColor Cyan

# 1. Check / Extract NDK if needed
if (-not (Test-Path (Join-Path $ndkTargetDir "source.properties"))) {
    if (-not (Test-Path $ndkZip)) {
        Write-Error "NDK zip file not found at $ndkZip"
    }
    Write-Host "Extracting NDK from $ndkZip..." -ForegroundColor Yellow
    $tempNdk = Join-Path $downloadsDir "ndk_temp"
    if (Test-Path $tempNdk) { Remove-Item -Recurse -Force $tempNdk }
    New-Item -ItemType Directory -Path $tempNdk -Force | Out-Null

    & C:\Windows\System32\tar.exe -xf $ndkZip -C $tempNdk
    $innerDir = Get-ChildItem -Path $tempNdk -Directory | Select-Object -First 1
    if (-not $innerDir) {
        Write-Error "Failed to locate extracted NDK folder in $tempNdk"
    }

    if (Test-Path $ndkTargetDir) {
        Remove-Item -Recurse -Force $ndkTargetDir
    }
    $ndkParent = Join-Path $sdkDir "ndk"
    if (-not (Test-Path $ndkParent)) { New-Item -ItemType Directory -Path $ndkParent -Force | Out-Null }

    Move-Item -Path $innerDir.FullName -Destination $ndkTargetDir
    Remove-Item -Recurse -Force $tempNdk
    Write-Host "NDK installed successfully to $ndkTargetDir" -ForegroundColor Green
} else {
    Write-Host "NDK already installed at $ndkTargetDir" -ForegroundColor Green
}

# 2. Environment config
$env:JAVA_HOME = $jdkDir
$env:ANDROID_HOME = $sdkDir
$env:ANDROID_SDK_ROOT = $sdkDir
$env:NDK_HOME = $ndkTargetDir
$env:ANDROID_NDK_HOME = $ndkTargetDir
$env:PATH = "$jdkDir\bin;$cmdlineLatestDir\bin;$sdkDir\platform-tools;" + $env:PATH

# 3. Accept Licenses
$licensesDir = Join-Path $sdkDir "licenses"
if (-not (Test-Path $licensesDir)) { New-Item -ItemType Directory -Path $licensesDir -Force | Out-Null }
@{
    "android-sdk-license" = "24333f8a63b6825ea9c5514f83c2829b004d1fee`nd56f5187479451eabf01fb78af6dfcb131a6481e`n84831b9409646a2b80f42d31a52f9b6d4357b98a"
    "android-sdk-preview-license" = "84831b9409646a2b80f42d31a52f9b6d4357b98a"
    "android-googletv-license" = "601085b94cd77f0b54ff86406957099fed7926d4"
    "google-gdk-license" = "33b6a2b64607f11b759f320ef9dff4ae5c47d97a"
    "mips-android-sysimage-license" = "e9acab587f418386db322c546dd847b4ca93f245"
}.GetEnumerator() | ForEach-Object {
    $licFile = Join-Path $licensesDir $_.Key
    Set-Content -Path $licFile -Value $_.Value -NoNewline
}

# 4. Install platforms;android-34 and build-tools;34.0.0 via sdkmanager
$platform34 = Join-Path $sdkDir "platforms\android-34"
$buildTools34 = Join-Path $sdkDir "build-tools\34.0.0"

if (-not (Test-Path $platform34) -or -not (Test-Path $buildTools34)) {
    Write-Host "Installing platforms;android-34, build-tools;34.0.0, platform-tools..." -ForegroundColor Yellow
    & "$cmdlineLatestDir\bin\sdkmanager.bat" --sdk_root=$sdkDir "platforms;android-34" "build-tools;34.0.0" "platform-tools"
    Write-Host "SDK components installed." -ForegroundColor Green
} else {
    Write-Host "platforms;android-34 and build-tools;34.0.0 already present." -ForegroundColor Green
}

# 5. Initialize Android target in Tauri if not already created
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

# Load session env (pnpm, rust, etc.)
. "$PSScriptRoot\env.ps1"

# Re-ensure Android env is active
$env:JAVA_HOME = $jdkDir
$env:ANDROID_HOME = $sdkDir
$env:ANDROID_SDK_ROOT = $sdkDir
$env:NDK_HOME = $ndkTargetDir
$env:ANDROID_NDK_HOME = $ndkTargetDir
$env:PATH = "$jdkDir\bin;$cmdlineLatestDir\bin;$sdkDir\platform-tools;" + $env:PATH

$androidDir = Join-Path $projectRoot "src-tauri\gen\android"
if (-not (Test-Path $androidDir)) {
    Write-Host "Initializing Tauri Android shell project..." -ForegroundColor Cyan
    & pnpm run tauri android init --ci --skip-targets-install
    Write-Host "Tauri Android project initialized at $androidDir" -ForegroundColor Green
} else {
    Write-Host "Tauri Android project already exists at $androidDir" -ForegroundColor Green
}

Write-Host "=== Setup & Init Complete ===" -ForegroundColor Green
