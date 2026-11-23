# scripts/build-android.ps1
# Reproducible Android arm64 APK build script for Linden Leaf.
# Parameterized via standard Android/Java/Rust environment variables (ANDROID_HOME, ANDROID_NDK_HOME,
# JAVA_HOME, LINDEN_BUILD_ROOT, LINDEN_TOOLCHAINS_DIR) and prevents Windows MuPDF variables from
# leaking into Android cross-compilation.

param(
    [ValidateSet('Debug', 'Release')]
    [string]$Mode = 'Debug',
    [string]$Version = '1.0.0',
    [string]$Tag = '',
    [ValidateRange(1, 2100000000)]
    [int]$VersionCode,
    [switch]$NativePdf,
    [switch]$OfflineGradle = $false
)

$ErrorActionPreference = 'Stop'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

# 1. Clear Windows MuPDF / incompatible target variables so they never leak into Android builds
foreach ($var in @(
    'LL_MUPDF_INCLUDE', 'LL_MUPDF_LIB_DIR', 'LL_MUPDF_LIBS',
    'LL_REQUIRE_NATIVE_MUPDF', 'LL_MUPDF_REQUIRED', 'LL_MUPDF_ANDROID_LIB_DIR',
    'CC', 'CXX', 'AR', 'RANLIB',
    'ANDROID_SDK_HOME', 'ANDROID_PREFS_ROOT'
)) {
    [Environment]::SetEnvironmentVariable($var, $null, 'Process')
}

# 2. Discover Android SDK, NDK, JDK, and build caches from standard env vars or local defaults
$toolchainRoot = if ($env:LINDEN_TOOLCHAINS_DIR) { $env:LINDEN_TOOLCHAINS_DIR } elseif ($env:LINDEN_TOOLCHAIN_ROOT) { $env:LINDEN_TOOLCHAIN_ROOT } else { '' }

$jdkHome = if ($env:JAVA_HOME) {
    $env:JAVA_HOME
} elseif ($toolchainRoot -and (Test-Path -LiteralPath (Join-Path $toolchainRoot 'Android\jdk'))) {
    Join-Path $toolchainRoot 'Android\jdk'
} elseif (Test-Path -LiteralPath "${env:ProgramFiles}\Android\Android Studio\jbr") {
    "${env:ProgramFiles}\Android\Android Studio\jbr"
} else {
    $javaCmd = Get-Command java -ErrorAction SilentlyContinue
    if ($javaCmd) { Split-Path -Parent (Split-Path -Parent $javaCmd.Source) } else { '' }
}

$sdkHome = if ($env:ANDROID_HOME) {
    $env:ANDROID_HOME
} elseif ($env:ANDROID_SDK_ROOT) {
    $env:ANDROID_SDK_ROOT
} elseif ($toolchainRoot -and (Test-Path -LiteralPath (Join-Path $toolchainRoot 'Android\sdk'))) {
    Join-Path $toolchainRoot 'Android\sdk'
} else {
    Join-Path $env:LOCALAPPDATA 'Android\Sdk'
}

$ndkHome = if ($env:ANDROID_NDK_HOME) {
    $env:ANDROID_NDK_HOME
} elseif ($env:NDK_HOME) {
    $env:NDK_HOME
} elseif ($sdkHome -and (Test-Path -LiteralPath (Join-Path $sdkHome 'ndk'))) {
    $preferredNdk = Join-Path $sdkHome 'ndk\26.3.11579264'
    if (Test-Path -LiteralPath $preferredNdk) {
        $preferredNdk
    } else {
        Get-ChildItem -LiteralPath (Join-Path $sdkHome 'ndk') -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
} else {
    ''
}

foreach ($entry in @(
    @{ Name = 'JAVA_HOME'; Path = $jdkHome },
    @{ Name = 'ANDROID_HOME'; Path = $sdkHome },
    @{ Name = 'ANDROID_NDK_HOME'; Path = $ndkHome }
)) {
    if (-not $entry.Path -or -not (Test-Path -LiteralPath $entry.Path)) {
        throw "Required Android toolchain directory missing for $($entry.Name): '$($entry.Path)'. Set $($entry.Name) (or LINDEN_TOOLCHAINS_DIR)."
    }
}

$buildBase = if ($env:LINDEN_BUILD_ROOT) {
    $env:LINDEN_BUILD_ROOT
} elseif ($env:LINDEN_BUILD_BASE) {
    $env:LINDEN_BUILD_BASE
} else {
    Join-Path $projectRoot '.build-android'
}
$gradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $buildBase '.gradle' }
$cargoTargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $buildBase 'target' }
$tempRoot = Join-Path $buildBase 'temp'
$nodeCacheDir = Join-Path $tempRoot 'node-compile-cache'

New-Item -ItemType Directory -Force -Path $gradleHome, $cargoTargetDir, $tempRoot, $nodeCacheDir | Out-Null

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $sdkHome
$env:ANDROID_SDK_ROOT = $sdkHome
$env:NDK_HOME = $ndkHome
$env:ANDROID_NDK_HOME = $ndkHome
$env:GRADLE_USER_HOME = $gradleHome
if (-not $env:RUSTUP_HOME -and $toolchainRoot -and (Test-Path -LiteralPath (Join-Path $toolchainRoot 'rustup'))) {
    $env:RUSTUP_HOME = Join-Path $toolchainRoot 'rustup'
}
if (-not $env:CARGO_HOME -and $toolchainRoot -and (Test-Path -LiteralPath (Join-Path $toolchainRoot 'cargo'))) {
    $env:CARGO_HOME = Join-Path $toolchainRoot 'cargo'
}
$env:CARGO_TARGET_DIR = $cargoTargetDir
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:NODE_COMPILE_CACHE = $nodeCacheDir
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$tempRoot"
$env:CARGO_BUILD_JOBS = if ($env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS } else { '2' }

# Host MSVC paths only for host build.rs & proc-macros (never Android target)
$msvcToolsetDir = ''
if ($env:LINDEN_MSVC_DIR -and (Test-Path -LiteralPath $env:LINDEN_MSVC_DIR)) {
    $msvcToolsetDir = $env:LINDEN_MSVC_DIR
} else {
    $vsRootCandidates = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $detectedVs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1
        if ($detectedVs) { $vsRootCandidates += $detectedVs }
    }
    if ($toolchainRoot) { $vsRootCandidates += (Join-Path $toolchainRoot 'MSVC') }
    foreach ($vsRoot in $vsRootCandidates) {
        $msvcBase = Join-Path $vsRoot 'VC\Tools\MSVC'
        if (Test-Path -LiteralPath $msvcBase) {
            $latestToolset = Get-ChildItem -LiteralPath $msvcBase -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
            if ($latestToolset) { $msvcToolsetDir = $latestToolset.FullName; break }
        }
    }
}

$windowsSdkDir = if ($env:LINDEN_WINSDK_DIR) { $env:LINDEN_WINSDK_DIR } else { "${env:ProgramFiles(x86)}\Windows Kits\10" }
$windowsSdkVersion = if ($env:LINDEN_WINSDK_VERSION) {
    $env:LINDEN_WINSDK_VERSION
} elseif (Test-Path -LiteralPath (Join-Path $windowsSdkDir 'Include')) {
    Get-ChildItem -LiteralPath (Join-Path $windowsSdkDir 'Include') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.' } |
        Sort-Object Name -Descending |
        Select-Object -First 1 -ExpandProperty Name
} else {
    ''
}

if ($msvcToolsetDir -and $windowsSdkDir -and $windowsSdkVersion -and (Test-Path -LiteralPath "$windowsSdkDir\Include\$windowsSdkVersion")) {
    $env:INCLUDE = @(
        "$msvcToolsetDir\include",
        "$windowsSdkDir\Include\$windowsSdkVersion\ucrt",
        "$windowsSdkDir\Include\$windowsSdkVersion\shared",
        "$windowsSdkDir\Include\$windowsSdkVersion\um"
    ) -join ';'
    $env:LIB = @(
        "$msvcToolsetDir\lib\x64",
        "$windowsSdkDir\Lib\$windowsSdkVersion\ucrt\x64",
        "$windowsSdkDir\Lib\$windowsSdkVersion\um\x64"
    ) -join ';'
    $env:LIBPATH = "$msvcToolsetDir\lib\x64"
}

$prebuiltDir = Join-Path $ndkHome 'toolchains\llvm\prebuilt'
$ndkPrebuiltHost = if (Test-Path -LiteralPath (Join-Path $prebuiltDir 'windows-x86_64')) {
    Join-Path $prebuiltDir 'windows-x86_64'
} else {
    Get-ChildItem -LiteralPath $prebuiltDir -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
$ndkLlvmBin = Join-Path $ndkPrebuiltHost 'bin'

$prependPaths = @()
if ($env:CARGO_HOME) { $prependPaths += (Join-Path $env:CARGO_HOME 'bin') }
if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.cargo\bin')) { $prependPaths += (Join-Path $env:USERPROFILE '.cargo\bin') }
$prependPaths += @(
    (Join-Path $jdkHome 'bin'),
    (Join-Path $sdkHome 'platform-tools'),
    $ndkLlvmBin
)
if ($msvcToolsetDir) { $prependPaths += "$msvcToolsetDir\bin\Hostx64\x64" }
$prependPaths = $prependPaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if ($prependPaths.Count -gt 0) {
    $env:PATH = ($prependPaths -join ';') + ';' + $env:PATH
}

# NDK compiler/linker variables for aarch64-linux-android target only
$env:CC_aarch64_linux_android = Join-Path $ndkLlvmBin 'aarch64-linux-android24-clang.cmd'
$env:CXX_aarch64_linux_android = Join-Path $ndkLlvmBin 'aarch64-linux-android24-clang++.cmd'
$env:AR_aarch64_linux_android = Join-Path $ndkLlvmBin 'llvm-ar.exe'
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $ndkLlvmBin 'aarch64-linux-android24-clang.cmd'

# Check disk space on the actual build drive before starting
$buildDriveName = [IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $buildBase).Path).TrimEnd(':', '\', '/')
$buildDrive = Get-PSDrive -Name $buildDriveName -ErrorAction SilentlyContinue
if ($buildDrive) {
    Write-Host ("[build-android] {0}: free space = {1:N2} GB" -f $buildDriveName, ($buildDrive.Free / 1GB)) -ForegroundColor Cyan
    if ($buildDrive.Free -lt 1.5GB) {
        throw "Insufficient free space on drive ${buildDriveName}: (< 1.5 GB)."
    }
}

# Validate Release signing configuration (never copies personal ~/.android/debug.keystore)
$androidGenRoot = Join-Path $projectRoot 'src-tauri\gen\android'
$keystorePropsPath = Join-Path $androidGenRoot 'keystore.properties'
$hasEnvSigning = (
    -not [string]::IsNullOrWhiteSpace($env:LINDEN_ANDROID_KEYSTORE_PATH) -and
    -not [string]::IsNullOrWhiteSpace($env:LINDEN_ANDROID_KEYSTORE_PASSWORD) -and
    -not [string]::IsNullOrWhiteSpace($env:LINDEN_ANDROID_KEY_ALIAS) -and
    -not [string]::IsNullOrWhiteSpace($env:LINDEN_ANDROID_KEY_PASSWORD)
)
if ($Mode -eq 'Release') {
    if (Test-Path -LiteralPath $keystorePropsPath) {
        Write-Host "[build-android] Release signing configured via src-tauri/gen/android/keystore.properties" -ForegroundColor Green
    } elseif ($hasEnvSigning) {
        Write-Host "[build-android] Release signing configured via LINDEN_ANDROID_KEYSTORE_* environment variables" -ForegroundColor Green
    } else {
        Write-Warning "[build-android] No release keystore found (keystore.properties or LINDEN_ANDROID_KEYSTORE_*). Gradle will fall back to debug signing — do NOT distribute publicly! See src-tauri/gen/android/keystore.properties.example."
    }
}

# Ensure aarch64-linux-android Rust target is installed
$targets = & rustup target list --installed
if ($targets -notcontains 'aarch64-linux-android') {
    throw 'Rust target aarch64-linux-android is not installed.'
}

$startedAt = Get-Date
$modeLower = $Mode.ToLowerInvariant()

# Step 1: Rebuild frontend dist & dist-tauri/build-info.json
Write-Host "[build-android] Running: node scripts/build-dist.js" -ForegroundColor Cyan
& node (Join-Path $projectRoot 'scripts\build-dist.js')
if ($LASTEXITCODE -ne 0) {
    throw "node scripts/build-dist.js failed with exit code $LASTEXITCODE"
}

# Step 2: Sync Android properties and runtime tauri.conf.json asset
$tauriConfPath = Join-Path $projectRoot 'src-tauri\tauri.conf.json'
$tauriConf = Get-Content -LiteralPath $tauriConfPath -Raw | ConvertFrom-Json
if ($tauriConf.version -ne $Version) {
    throw "Version mismatch: src-tauri/tauri.conf.json has '$($tauriConf.version)' != '$Version'"
}
$verParts = $Version.Split('.') | ForEach-Object { [int]$_ }
if (!$PSBoundParameters.ContainsKey('VersionCode')) {
    $versionCode = ($verParts[0] * 1000000) + ($verParts[1] * 1000) + $verParts[2]
}

$tauriPropsPath = Join-Path $androidGenRoot 'app\tauri.properties'
$propsContent = @(
    '// THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.'
    "tauri.android.versionName=$Version"
    "tauri.android.versionCode=$versionCode"
) -join "`n"
[System.IO.File]::WriteAllText($tauriPropsPath, $propsContent, (New-Object System.Text.UTF8Encoding($false)))

$androidAssetsDir = Join-Path $androidGenRoot 'app\src\main\assets'
New-Item -ItemType Directory -Force -Path $androidAssetsDir | Out-Null
Copy-Item -LiteralPath $tauriConfPath -Destination (Join-Path $androidAssetsDir 'tauri.conf.json') -Force

if ($NativePdf) {
    & (Join-Path $PSScriptRoot 'build-mupdf-android.ps1') -NdkHome $ndkHome -BuildBase $buildBase
}

# Step 3: Build Rust native library for aarch64-linux-android
$cargoArgs = @(
    'build',
    '--package', 'linden-leaf',
    '--manifest-path', (Join-Path $projectRoot 'src-tauri\Cargo.toml'),
    '--target', 'aarch64-linux-android',
    '--features', 'tauri/custom-protocol',
    '--lib'
)
if ($Mode -eq 'Release') {
    $cargoArgs += '--release'
}
Write-Host "[build-android] Running: cargo $($cargoArgs -join ' ')" -ForegroundColor Cyan
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) {
    throw "cargo build for aarch64-linux-android failed with exit code $LASTEXITCODE"
}

# Step 4: Copy .so directly into jniLibs (avoids Windows symlink privilege failures)
$soSource = Join-Path $cargoTargetDir "aarch64-linux-android\$modeLower\liblinden_leaf_lib.so"
if (-not (Test-Path -LiteralPath $soSource)) {
    throw "Compiled native library missing: $soSource"
}
$jniArm64Dir = Join-Path $androidGenRoot 'app\src\main\jniLibs\arm64-v8a'
New-Item -ItemType Directory -Force -Path $jniArm64Dir | Out-Null
$soDest = Join-Path $jniArm64Dir 'liblinden_leaf_lib.so'
if (Test-Path -LiteralPath $soDest) {
    Remove-Item -LiteralPath $soDest -Force
}
Copy-Item -LiteralPath $soSource -Destination $soDest -Force
Write-Host "[build-android] Staged .so ($((Get-Item -LiteralPath $soDest).Length) bytes) -> $soDest" -ForegroundColor Cyan

# Step 5: Assemble arm64 APK via Gradle using pre-staged native library
$env:LINDEN_EXPLICIT_PRESTAGED_SO = '1'
$apkRoot = Join-Path $projectRoot 'src-tauri\gen\android\app\build\outputs\apk'
if (Test-Path -LiteralPath $apkRoot) {
    Remove-Item -LiteralPath $apkRoot -Recurse -Force
}
$gradleTask = if ($Mode -eq 'Release') { 'assembleArm64Release' } else { 'assembleArm64Debug' }
$gradlew = Join-Path $androidGenRoot 'gradlew.bat'
$gradleArgs = @('-p', $androidGenRoot, '--no-daemon', $gradleTask)
if ($OfflineGradle) {
    $gradleArgs += '--offline'
}
Write-Host "[build-android] Running: gradlew.bat $($gradleArgs -join ' ')" -ForegroundColor Cyan
& $gradlew @gradleArgs
if ($LASTEXITCODE -ne 0) {
    throw "Gradle $gradleTask failed with exit code $LASTEXITCODE"
}

# Locate freshly produced arm64 APK
$apkRoot = Join-Path $projectRoot 'src-tauri\gen\android\app\build\outputs\apk'
$apkCandidates = Get-ChildItem -LiteralPath $apkRoot -Recurse -File -Filter '*.apk' -ErrorAction SilentlyContinue |
    Where-Object { ($_.FullName -like "*\arm64\$modeLower\*" -or $_.Name -like "*arm64*$modeLower*.apk") } |
    Sort-Object LastWriteTime -Descending

$builtApk = $apkCandidates | Select-Object -First 1
if (-not $builtApk) {
    throw "No $Mode APK found under $apkRoot"
}
if ($builtApk.LastWriteTime -lt $startedAt.AddMinutes(-5)) {
    throw "Found APK predates build start time ($($builtApk.LastWriteTime) < $startedAt)"
}

# Deliver to gitignored deliveries folder
$folderTag = if ($Tag) { "android-$Version-$Tag" } else { "android-$Version" }
$deliveryDir = Join-Path $projectRoot "deliveries\$folderTag"
New-Item -ItemType Directory -Force -Path $deliveryDir | Out-Null
$destName = "lindenleaf-arm64-$modeLower.apk"
$destPath = Join-Path $deliveryDir $destName
Copy-Item -LiteralPath $builtApk.FullName -Destination $destPath -Force

$sha256 = (Get-FileHash -LiteralPath $destPath -Algorithm SHA256).Hash
$buildInfoPath = Join-Path $projectRoot 'dist-tauri\build-info.json'
$buildInfo = if (Test-Path -LiteralPath $buildInfoPath) { Get-Content -LiteralPath $buildInfoPath -Raw } else { '{}' }

$freeAfterGB = if ($buildDrive) {
    $buildDriveNow = Get-PSDrive -Name $buildDriveName -ErrorAction SilentlyContinue
    if ($buildDriveNow) { [math]::Round(($buildDriveNow.Free / 1GB), 2) } else { $null }
} else {
    $null
}

Write-Host "[build-android] Build succeeded!" -ForegroundColor Green
[PSCustomObject]@{
    Mode = $Mode
    SourceApk = $builtApk.FullName
    DeliveredApk = $destPath
    SizeBytes = (Get-Item -LiteralPath $destPath).Length
    SHA256 = $sha256
    LastWriteTime = (Get-Item -LiteralPath $destPath).LastWriteTime
    FreeAfterGB = $freeAfterGB
} | Format-List
Write-Output "=== dist-tauri/build-info.json ==="
Write-Output $buildInfo
