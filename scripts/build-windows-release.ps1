# scripts/build-windows-release.ps1
# Builds the Windows x64 release deliverables (NSIS setup installer, MSI, and portable ZIP)
# Output is placed in D:\LindenLeaf-Deliveries\2026-09-29\windows\

param(
    [string]$SubDir = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

Write-Host "=== Linden Leaf Windows x64 Release Build Pipeline ===" -ForegroundColor Cyan

# 1. Load project session environment (Git, Node, PNPM, Rust, MSVC)
$envScript = Join-Path $PSScriptRoot "env.ps1"
if (Test-Path $envScript) {
    . $envScript
}

# 2. Isolate environment from Android cross-compilation variables
$androidVars = @(
    "CC_aarch64_linux_android", "CXX_aarch64_linux_android", "AR_aarch64_linux_android",
    "RANLIB_aarch64_linux_android", "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER",
    "RUSTFLAGS", "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_NDK_HOME", "NDK_HOME"
)
foreach ($var in $androidVars) {
    if (Test-Path "env:$var") {
        Remove-Item -Path "env:$var" -Force -ErrorAction SilentlyContinue
    }
}

$env:CARGO_TARGET_DIR = "D:\LindenLeaf-Build\target"

Write-Host "Environment Summary (Windows MSVC x64):" -ForegroundColor Yellow
Write-Host "  INCLUDE: $env:INCLUDE"
Write-Host "  LIB: $env:LIB"
Write-Host "  CARGO_TARGET_DIR: $env:CARGO_TARGET_DIR"

# 3. Compile frontend distribution
Write-Host "Compiling frontend distribution..." -ForegroundColor Cyan
& node scripts/build-dist.js
if ($LASTEXITCODE -ne 0) {
    throw "Frontend distribution build failed with exit code $LASTEXITCODE"
}

# 4. Clean previous Windows bundle outputs to prevent delivering stale packages
$bundleOutputDir = Join-Path $env:CARGO_TARGET_DIR "x86_64-pc-windows-msvc\release\bundle"
if (Test-Path $bundleOutputDir) {
    Write-Host "Cleaning previous bundle directory at $bundleOutputDir..." -ForegroundColor Cyan
    Remove-Item -Path $bundleOutputDir -Recurse -Force
}

$releaseExe = Join-Path $env:CARGO_TARGET_DIR "x86_64-pc-windows-msvc\release\linden-leaf.exe"
if (Test-Path $releaseExe) {
    Remove-Item -Path $releaseExe -Force
}

# 5. Build Windows Release Binary and Installers via Tauri CLI
Write-Host "Building Tauri Windows Release (NSIS + MSI)..." -ForegroundColor Cyan
& pnpm tauri build --target x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $releaseExe)) {
    throw "Tauri build finished but release binary does not exist at $releaseExe"
}

$releaseLength = (Get-Item $releaseExe).Length
Write-Host "Built Windows release binary: $releaseExe ($([math]::Round($releaseLength / 1MB, 2)) MB, $releaseLength bytes)" -ForegroundColor Green

# 6. Deliver Installers and Portable ZIP
$baseDeliveryDir = "D:\LindenLeaf-Deliveries\2026-09-29"
$targetSubDir = if ($SubDir) { $SubDir } elseif ($env:LINDEN_DELIVERY_SUBDIR) { $env:LINDEN_DELIVERY_SUBDIR } else { "" }
if ($targetSubDir) {
    $deliveryDir = Join-Path $baseDeliveryDir "$targetSubDir\windows"
} else {
    $deliveryDir = Join-Path $baseDeliveryDir "windows"
    if (Test-Path (Join-Path $deliveryDir "LindenLeaf-1.2.3-x64-portable.zip")) {
        $runIdx = 2
        while (Test-Path (Join-Path $baseDeliveryDir "run$runIdx\windows\LindenLeaf-1.2.3-x64-portable.zip")) {
            $runIdx++
        }
        $deliveryDir = Join-Path $baseDeliveryDir "run$runIdx\windows"
    }
}
if (-not (Test-Path $deliveryDir)) {
    New-Item -ItemType Directory -Path $deliveryDir -Force | Out-Null
}

# (a) NSIS Setup Installer
$nsisDir = Join-Path $bundleOutputDir "nsis"
$nsisExe = $null
if (Test-Path $nsisDir) {
    $foundNsis = Get-ChildItem -Path $nsisDir -Filter "*.exe" | Select-Object -First 1
    if ($foundNsis) { $nsisExe = $foundNsis.FullName }
}
if ($nsisExe) {
    $destNsis = Join-Path $deliveryDir (Split-Path -Leaf $nsisExe)
    Copy-Item -Path $nsisExe -Destination $destNsis -Force
    $nsisLen = (Get-Item $destNsis).Length
    Write-Host "Delivered NSIS installer: $destNsis ($([math]::Round($nsisLen / 1MB, 2)) MB, $nsisLen bytes)" -ForegroundColor Green
} else {
    Write-Warning "NSIS installer was not found in $nsisDir"
}

# (b) MSI Installer (if generated)
$msiDir = Join-Path $bundleOutputDir "msi"
$msiFile = $null
if (Test-Path $msiDir) {
    $foundMsi = Get-ChildItem -Path $msiDir -Filter "*.msi" | Select-Object -First 1
    if ($foundMsi) { $msiFile = $foundMsi.FullName }
}
if ($msiFile) {
    $destMsi = Join-Path $deliveryDir (Split-Path -Leaf $msiFile)
    Copy-Item -Path $msiFile -Destination $destMsi -Force
    $msiLen = (Get-Item $destMsi).Length
    Write-Host "Delivered MSI installer: $destMsi ($([math]::Round($msiLen / 1MB, 2)) MB, $msiLen bytes)" -ForegroundColor Green
}

# (c) Portable ZIP distribution
Write-Host "Creating Portable ZIP package..." -ForegroundColor Cyan
$portableTemp = Join-Path $env:TEMP ("linden-leaf-portable-" + [System.Guid]::NewGuid().ToString().Substring(0, 8))
New-Item -ItemType Directory -Path $portableTemp -Force | Out-Null

Copy-Item -Path $releaseExe -Destination (Join-Path $portableTemp "linden-leaf.exe") -Force

# Include resource folder with dictionary metadata
$portableResources = Join-Path $portableTemp "resources\dictionary"
New-Item -ItemType Directory -Path $portableResources -Force | Out-Null
$metaSrc = Join-Path $projectRoot "resources\dictionary\metadata.json"
if (Test-Path $metaSrc) {
    Copy-Item -Path $metaSrc -Destination (Join-Path $portableResources "metadata.json") -Force
}

# Include LICENSE and documentation if present
$licenseSrc = Join-Path $projectRoot "LICENSE.txt"
if (-not (Test-Path $licenseSrc)) {
    $licenseSrc = Join-Path $projectRoot "LICENSE"
}
if (Test-Path $licenseSrc) {
    Copy-Item -Path $licenseSrc -Destination (Join-Path $portableTemp "LICENSE.txt") -Force
}

$readmeSrc = Join-Path $projectRoot "README.md"
if (Test-Path $readmeSrc) {
    Copy-Item -Path $readmeSrc -Destination (Join-Path $portableTemp "README.md") -Force
}

$destZip = Join-Path $deliveryDir "LindenLeaf-1.2.3-x64-portable.zip"
if (Test-Path $destZip) {
    Remove-Item -Path $destZip -Force
}
Compress-Archive -Path "$portableTemp\*" -DestinationPath $destZip -CompressionLevel Optimal
Remove-Item -Path $portableTemp -Recurse -Force -ErrorAction SilentlyContinue

$zipLen = (Get-Item $destZip).Length
Write-Host "Delivered Portable ZIP: $destZip ($([math]::Round($zipLen / 1MB, 2)) MB, $zipLen bytes)" -ForegroundColor Green

Write-Host "=== Windows Release Build Complete ===" -ForegroundColor Green
