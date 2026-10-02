# scripts/build-android-apk.ps1
# Builds an arm64 release-optimized APK for Linden Leaf using the isolated Android toolchain at D:\LindenLeaf-Toolchains\Android.
# Output is placed in D:\LindenLeaf-Deliveries\2026-09-29\android\

param(
    [string]$SubDir = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "=== Linden Leaf Android APK Build Pipeline ===" -ForegroundColor Cyan

# 1. Load project session environment (Git, Node, PNPM, Rust, MSVC)
$envScript = Join-Path $PSScriptRoot "env.ps1"
if (Test-Path $envScript) {
    . $envScript
}

# 2. Configure Android Toolchain paths
$androidToolchainsBase = "D:\LindenLeaf-Toolchains\Android"
$jdkDir = Join-Path $androidToolchainsBase "jdk"
$sdkDir = Join-Path $androidToolchainsBase "sdk"
$cmdlineDir = Join-Path $sdkDir "cmdline-tools\latest\bin"

# Discover installed NDK (prefer fixed 26.3 if available)
$ndkBase = Join-Path $sdkDir "ndk"
$ndkDir = $null
if (Test-Path (Join-Path $ndkBase "26.3.11579264")) {
    $ndkDir = Join-Path $ndkBase "26.3.11579264"
} elseif (Test-Path $ndkBase) {
    $foundNdk = Get-ChildItem -Path $ndkBase -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($foundNdk) { $ndkDir = $foundNdk.FullName }
}

$env:JAVA_HOME = $jdkDir
$env:ANDROID_HOME = $sdkDir
$env:ANDROID_SDK_ROOT = $sdkDir
$llvmStrip = $null
$llvmReadelf = $null

if ($ndkDir) {
    $env:ANDROID_NDK_HOME = $ndkDir
    $env:NDK_HOME = $ndkDir
    $llvmBin = Join-Path $ndkDir "toolchains\llvm\prebuilt\windows-x86_64\bin"
    if (Test-Path $llvmBin) {
        $env:PATH = "$llvmBin;" + $env:PATH
        $env:CC_aarch64_linux_android = Join-Path $llvmBin "aarch64-linux-android24-clang.cmd"
        $env:CXX_aarch64_linux_android = Join-Path $llvmBin "aarch64-linux-android24-clang++.cmd"
        Set-Item -Path "env:CC_aarch64_linux_android" -Value (Join-Path $llvmBin "aarch64-linux-android24-clang.cmd")
        Set-Item -Path "env:CXX_aarch64_linux_android" -Value (Join-Path $llvmBin "aarch64-linux-android24-clang++.cmd")
        $env:AR_aarch64_linux_android = Join-Path $llvmBin "llvm-ar.exe"
        Set-Item -Path "env:AR_aarch64_linux_android" -Value (Join-Path $llvmBin "llvm-ar.exe")
        $env:RANLIB_aarch64_linux_android = Join-Path $llvmBin "llvm-ranlib.exe"
        Set-Item -Path "env:RANLIB_aarch64_linux_android" -Value (Join-Path $llvmBin "llvm-ranlib.exe")
        $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $llvmBin "aarch64-linux-android24-clang.cmd"
        $llvmStrip = Join-Path $llvmBin "llvm-strip.exe"
        $llvmReadelf = Join-Path $llvmBin "llvm-readelf.exe"
    }
}

# Isolated Gradle and build cache
$env:GRADLE_USER_HOME = "D:\LindenLeaf-Build\.gradle"
$env:CARGO_TARGET_DIR = "D:\LindenLeaf-Build\target"

# Path injection
$env:PATH = "$jdkDir\bin;$cmdlineDir;$sdkDir\platform-tools;" + $env:PATH

Write-Host "Environment Summary:" -ForegroundColor Yellow
Write-Host "  JAVA_HOME: $env:JAVA_HOME"
Write-Host "  ANDROID_HOME: $env:ANDROID_HOME"
Write-Host "  NDK_HOME: $env:NDK_HOME"
Write-Host "  GRADLE_USER_HOME: $env:GRADLE_USER_HOME"
Write-Host "  CARGO_TARGET_DIR: $env:CARGO_TARGET_DIR"

# 3. Check Android Shell project
$androidProjectDir = Join-Path $projectRoot "src-tauri\gen\android"
if (-not (Test-Path $androidProjectDir)) {
    throw "Tauri Android project structure not found at $androidProjectDir"
}

# 4. Compile frontend distribution
Write-Host "Compiling frontend distribution..." -ForegroundColor Cyan
& node scripts/build-dist.js
if ($LASTEXITCODE -ne 0) {
    throw "Frontend distribution build failed with exit code $LASTEXITCODE"
}

# 5. Clean intermediate outputs to ensure no stale artifacts or zipflinger gaps
$jniTargetDir = Join-Path $androidProjectDir "app\src\main\jniLibs\arm64-v8a"
if (-not (Test-Path $jniTargetDir)) {
    New-Item -ItemType Directory -Path $jniTargetDir -Force | Out-Null
}
$targetSo = Join-Path $jniTargetDir "liblinden_leaf_lib.so"
if (Test-Path $targetSo) {
    Remove-Item -Path $targetSo -Force
}

$gradleBuildDir = Join-Path $androidProjectDir "app\build"
if (Test-Path $gradleBuildDir) {
    Write-Host "Cleaning Gradle build directory to prevent zipflinger padding accumulation..." -ForegroundColor Cyan
    Remove-Item -Path $gradleBuildDir -Recurse -Force
}

# 6. Build ARM64 Native Library with Release Optimizations and 16KB Page Alignment
Write-Host "Compiling Rust cdylib for aarch64-linux-android (release, 16KB page alignment)..." -ForegroundColor Cyan
$env:RUSTFLAGS = "-C link-arg=-Wl,-z,max-page-size=16384"
& cargo build --package linden-leaf --manifest-path (Join-Path $projectRoot "src-tauri\Cargo.toml") --target aarch64-linux-android --release --features "tauri/custom-protocol" --lib
if ($LASTEXITCODE -ne 0) {
    throw "Cargo cross-compilation failed with exit code $LASTEXITCODE"
}

$builtSo = Join-Path $env:CARGO_TARGET_DIR "aarch64-linux-android\release\liblinden_leaf_lib.so"
if (-not (Test-Path $builtSo)) {
    throw "Build failed: $builtSo does not exist."
}

# Strip debug symbols using llvm-strip
if ($llvmStrip -and (Test-Path $llvmStrip)) {
    Write-Host "Stripping symbols from $builtSo..." -ForegroundColor Cyan
    & $llvmStrip --strip-all $builtSo
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "llvm-strip failed with exit code $LASTEXITCODE; continuing with unstripped binary."
    }
}

# Verify 16KB alignment
if ($llvmReadelf -and (Test-Path $llvmReadelf)) {
    Write-Host "Verifying 16KB page alignment on $builtSo..." -ForegroundColor Cyan
    $headers = & $llvmReadelf -l $builtSo
    $loadLines = $headers | Where-Object { $_ -match "LOAD" }
    Write-Host "  ELF LOAD segment alignments:" -ForegroundColor Gray
    foreach ($line in $loadLines) {
        Write-Host "    $line" -ForegroundColor Gray
    }
}

Copy-Item -Path $builtSo -Destination $targetSo -Force
$soLength = (Get-Item $targetSo).Length
$env:LINDEN_EXPLICIT_PRESTAGED_SO = "1"
Write-Host "Staged native library at $targetSo ($([math]::Round($soLength / 1MB, 2)) MB, $soLength bytes)" -ForegroundColor Green

# Sync tauri.conf.json to assets
$assetsDir = Join-Path $androidProjectDir "app\src\main\assets"
if (-not (Test-Path $assetsDir)) {
    New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null
}
Copy-Item -Path (Join-Path $projectRoot "src-tauri\tauri.conf.json") -Destination (Join-Path $assetsDir "tauri.conf.json") -Force

# 7. Assemble Android APK via Gradle
Write-Host "Assembling Android Release APK via Gradle..." -ForegroundColor Cyan
Push-Location $androidProjectDir
try {
    & .\gradlew.bat assembleArm64Release
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle assembleArm64Release failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

# 8. Locate generated APK and copy to delivery directory
$baseDeliveryDir = "D:\LindenLeaf-Deliveries\2026-09-29"
$targetSubDir = if ($SubDir) { $SubDir } elseif ($env:LINDEN_DELIVERY_SUBDIR) { $env:LINDEN_DELIVERY_SUBDIR } else { "" }
if ($targetSubDir) {
    $deliveryDir = Join-Path $baseDeliveryDir "$targetSubDir\android"
} else {
    $deliveryDir = Join-Path $baseDeliveryDir "android"
    if (Test-Path (Join-Path $deliveryDir "lindenleaf-arm64-release.apk")) {
        $runIdx = 2
        while (Test-Path (Join-Path $baseDeliveryDir "run$runIdx\android\lindenleaf-arm64-release.apk")) {
            $runIdx++
        }
        $deliveryDir = Join-Path $baseDeliveryDir "run$runIdx\android"
    }
}
if (-not (Test-Path $deliveryDir)) {
    New-Item -ItemType Directory -Path $deliveryDir -Force | Out-Null
}

$apkCandidate = Join-Path $androidProjectDir "app\build\outputs\apk\arm64\release\app-arm64-release.apk"
if (-not (Test-Path $apkCandidate)) {
    $apkCandidate = Join-Path $androidProjectDir "app\build\outputs\apk\arm64\release\app-arm64-release-unsigned.apk"
}

if (-not (Test-Path $apkCandidate)) {
    throw "Gradle reported success but output APK not found at $apkCandidate"
}

$destApk = Join-Path $deliveryDir "lindenleaf-arm64-release.apk"
Copy-Item -Path $apkCandidate -Destination $destApk -Force
$apkLength = (Get-Item $destApk).Length
$apkSizeMb = [math]::Round(($apkLength / 1MB), 2)
Write-Host "SUCCESS: Release APK built and delivered to $destApk" -ForegroundColor Green
Write-Host "  APK Size: $apkSizeMb MB ($apkLength bytes)" -ForegroundColor Green

# 9. Verify APK structure: Check for zero zip padding / gap records
Write-Host "Verifying APK ZIP structure..." -ForegroundColor Cyan
$verifyScript = @"
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
let pos = 0;
let gapCount = 0;
let gapBytes = 0;
let validEntries = 0;

while (pos < buf.length - 4) {
    if (buf.readUInt32LE(pos) === 0x04034b50) {
        const nameLen = buf.readUInt16LE(pos + 26);
        const extraLen = buf.readUInt16LE(pos + 28);
        const compSize = buf.readUInt32LE(pos + 18);
        if (nameLen === 0) {
            gapCount++;
            gapBytes += (30 + extraLen + compSize);
        } else {
            validEntries++;
        }
        pos += 30 + nameLen + extraLen + compSize;
    } else {
        pos++;
    }
}
console.log(JSON.stringify({ validEntries, gapCount, gapBytes }));
"@

$verifyFile = Join-Path $env:TEMP "verify-apk-zip.js"
[System.IO.File]::WriteAllText($verifyFile, $verifyScript)
$zipStatsJson = & node $verifyFile $destApk
Remove-Item -Path $verifyFile -Force -ErrorAction SilentlyContinue
Write-Host "  ZIP Structure Check: $zipStatsJson" -ForegroundColor Cyan
