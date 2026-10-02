# scripts/setup-android-toolchain.ps1
# Automates the setup of an isolated Android toolchain on D:\LindenLeaf-Toolchains\Android
# JDK 17 + Android SDK (platform-34, build-tools 34.0.0, platform-tools, NDK 26c)

$ErrorActionPreference = "Stop"

$baseDir = "D:\LindenLeaf-Toolchains\Android"
$downloadsDir = Join-Path $baseDir "downloads"
$jdkDir = Join-Path $baseDir "jdk"
$sdkDir = Join-Path $baseDir "sdk"
$cmdlineLatestDir = Join-Path $sdkDir "cmdline-tools\latest"

if (-not (Test-Path $downloadsDir)) { New-Item -ItemType Directory -Path $downloadsDir -Force | Out-Null }
if (-not (Test-Path $sdkDir)) { New-Item -ItemType Directory -Path $sdkDir -Force | Out-Null }

Write-Host "=== Linden Leaf Android Toolchain Provisioning ===" -ForegroundColor Cyan
Write-Host "Base Directory: $baseDir"

# 1. Download & Extract JDK 17 (Microsoft OpenJDK 17 x64)
$jdkZip = Join-Path $downloadsDir "microsoft-jdk-17.0.12-windows-x64.zip"
$javaExe = Join-Path $jdkDir "bin\java.exe"

if (-not (Test-Path $javaExe)) {
    if (-not (Test-Path $jdkZip) -or ((Get-Item $jdkZip).Length -lt 1000000)) {
        Write-Host "Downloading Microsoft OpenJDK 17 via curl..." -ForegroundColor Yellow
        $jdkUrl = "https://aka.ms/download-jdk/microsoft-jdk-17.0.12-windows-x64.zip"
        & C:\Windows\System32\curl.exe -L -o $jdkZip $jdkUrl
    }
    Write-Host "Extracting JDK 17 via tar..." -ForegroundColor Yellow
    if (Test-Path $jdkDir) { Remove-Item -Recurse -Force $jdkDir }
    $tempExtract = Join-Path $downloadsDir "jdk_temp"
    if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
    New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null
    & C:\Windows\System32\tar.exe -xf $jdkZip -C $tempExtract
    $innerDir = Get-ChildItem -Path $tempExtract -Directory | Select-Object -First 1
    Move-Item -Path $innerDir.FullName -Destination $jdkDir
    Remove-Item -Recurse -Force $tempExtract
    Write-Host "JDK 17 installed successfully." -ForegroundColor Green
} else {
    Write-Host "JDK 17 already present at $jdkDir" -ForegroundColor Green
}

# 2. Download & Extract Android Command-Line Tools
$cmdlineZip = Join-Path $downloadsDir "commandlinetools-win-11076708_latest.zip"
$sdkManagerBat = Join-Path $cmdlineLatestDir "bin\sdkmanager.bat"

if (-not (Test-Path $sdkManagerBat)) {
    if (-not (Test-Path $cmdlineZip) -or ((Get-Item $cmdlineZip).Length -lt 1000000)) {
        Write-Host "Downloading Android Command-line Tools via curl..." -ForegroundColor Yellow
        $cmdlineUrl = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
        & C:\Windows\System32\curl.exe -L -o $cmdlineZip $cmdlineUrl
    }
    Write-Host "Extracting Android Command-line Tools via tar..." -ForegroundColor Yellow
    $tempCmdline = Join-Path $downloadsDir "cmdline_temp"
    if (Test-Path $tempCmdline) { Remove-Item -Recurse -Force $tempCmdline }
    New-Item -ItemType Directory -Path $tempCmdline -Force | Out-Null
    & C:\Windows\System32\tar.exe -xf $cmdlineZip -C $tempCmdline
    
    $parentCmdline = Join-Path $sdkDir "cmdline-tools"
    if (-not (Test-Path $parentCmdline)) { New-Item -ItemType Directory -Path $parentCmdline -Force | Out-Null }
    if (Test-Path $cmdlineLatestDir) { Remove-Item -Recurse -Force $cmdlineLatestDir }
    
    $extractedFolder = Join-Path $tempCmdline "cmdline-tools"
    Move-Item -Path $extractedFolder -Destination $cmdlineLatestDir
    Remove-Item -Recurse -Force $tempCmdline
    Write-Host "Android Command-line Tools installed to $cmdlineLatestDir" -ForegroundColor Green
} else {
    Write-Host "Android Command-line Tools already present at $sdkManagerBat" -ForegroundColor Green
}

# 3. Environment configuration
$env:JAVA_HOME = $jdkDir
$env:ANDROID_HOME = $sdkDir
$env:PATH = "$jdkDir\bin;$cmdlineLatestDir\bin;$sdkDir\platform-tools;" + $env:PATH

Write-Host "Java verification:" -ForegroundColor Cyan
& "$jdkDir\bin\java.exe" -version

# 4. Accept Licenses
Write-Host "Accepting Android SDK licenses..." -ForegroundColor Yellow
$licensesDir = Join-Path $sdkDir "licenses"
if (-not (Test-Path $licensesDir)) { New-Item -ItemType Directory -Path $licensesDir -Force | Out-Null }

# Write standard accepted license hashes directly to avoid interactive prompt hangs
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

# 5. Install SDK Components: platform-34, build-tools 34.0.0, platform-tools, ndk
Write-Host "Installing Android SDK packages: platforms;android-34, build-tools;34.0.0, platform-tools, ndk;26.3.11579264..." -ForegroundColor Yellow
& "$cmdlineLatestDir\bin\sdkmanager.bat" --sdk_root=$sdkDir "platforms;android-34" "build-tools;34.0.0" "platform-tools" "ndk;26.3.11579264"

Write-Host "=== Android Toolchain Provisioning Complete ===" -ForegroundColor Green
