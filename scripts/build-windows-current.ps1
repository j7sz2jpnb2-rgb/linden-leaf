# scripts/build-windows-current.ps1
# Build script for Linden Leaf Windows release (NSIS) using MSVC and Tauri

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. (Join-Path $projectRoot 'scripts\env.ps1')

if (Test-Path 'D:\LindenLeaf-Toolchains\cargo\bin') {
    $localNsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
if (Test-Path $localNsis) { $env:PATH = "$localNsis;$env:PATH" }
if (Test-Path 'D:\LindenLeaf-Toolchains\cargo\bin') { $env:PATH = "D:\LindenLeaf-Toolchains\cargo\bin;$env:PATH" }
    $env:RUSTUP_HOME = 'D:\LindenLeaf-Toolchains\rustup'
    $env:CARGO_HOME = 'D:\LindenLeaf-Toolchains\cargo'
}

foreach ($variableName in @(
    'CC_aarch64_linux_android','CXX_aarch64_linux_android','AR_aarch64_linux_android',
    'RANLIB_aarch64_linux_android','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER',
    'RUSTFLAGS','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_HOME','NDK_HOME'
)) {
    [Environment]::SetEnvironmentVariable($variableName, $null, 'Process')
}

$tempRoot = Join-Path $projectRoot 'build-temp-2.0.17'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:CARGO_BUILD_JOBS = '1'

if ((Get-PSDrive D).Free -lt 1.0GB) {
    throw 'Insufficient D: drive free space (< 1.0 GB).'
}

Write-Host "=== 1. Building frontend distribution ===" -ForegroundColor Cyan
& node scripts/build-dist.js
if ($LASTEXITCODE -ne 0) {
    throw "Frontend distribution build failed: $LASTEXITCODE"
}

$delivery = if ($env:LINDEN_DELIVERY_DIR) { Join-Path $env:LINDEN_DELIVERY_DIR 'windows-2.0.17-mupdf' } else { Join-Path $projectRoot "deliveries\$(Get-Date -Format 'yyyy-MM-dd')\windows-2.0.17-mupdf" }
$name = 'Linden Leaf_2.0.17_x64-setup.exe'
$destination = Join-Path $delivery $name

$startedAt = Get-Date
Write-Host "=== 2. Building Tauri Windows Release binary & NSIS package ===" -ForegroundColor Cyan
$tauriMain = Join-Path $projectRoot 'node_modules\@tauri-apps\cli\main.js'
& node -e "require(process.argv[1]).run(process.argv.slice(2)).catch(err => { console.error(err); process.exit(1); })" $tauriMain build --target x86_64-pc-windows-msvc --bundles nsis
if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE"
}

$targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $projectRoot 'src-tauri\target' }
$candidateBinaries = @(
    (Join-Path $targetRoot 'x86_64-pc-windows-msvc\release\linden-leaf.exe'),
    (Join-Path $targetRoot 'release\linden-leaf.exe')
)
$binary = $candidateBinaries | Where-Object { Test-Path -LiteralPath $_ } | Get-Item | Sort-Object -Property LastWriteTime -Descending | Select-Object -ExpandProperty FullName -First 1

$candidateInstallers = @(
    (Join-Path $targetRoot "x86_64-pc-windows-msvc\release\bundle\nsis\$name"),
    (Join-Path $targetRoot "release\bundle\nsis\$name")
)
$installer = $candidateInstallers | Where-Object { Test-Path -LiteralPath $_ } | Get-Item | Sort-Object -Property LastWriteTime -Descending | Select-Object -ExpandProperty FullName -First 1

if (-not $binary -or -not (Test-Path -LiteralPath $binary)) {
    throw "Built binary missing in target directory: $targetRoot"
}
if ((Get-Item -LiteralPath $binary).LastWriteTime -lt $startedAt.AddMinutes(-10)) {
    throw "Built binary was not updated (timestamp older than build start time: $startedAt)"
}
if ((Get-Item -LiteralPath $binary).VersionInfo.ProductVersion -ne '2.0.17') {
    throw "Built binary version mismatch: $((Get-Item -LiteralPath $binary).VersionInfo.ProductVersion)"
}

if (-not $installer -or -not (Test-Path -LiteralPath $installer)) {
    throw "Expected NSIS installer is missing at $installer"
}
if ((Get-Item -LiteralPath $installer).LastWriteTime -lt $startedAt.AddMinutes(-10)) {
    throw "Installer predates this build (timestamp older than build start time: $startedAt)"
}

Write-Host "=== 3. Delivering release package ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $delivery | Out-Null
Copy-Item -LiteralPath $installer -Destination $destination -Force
Copy-Item -LiteralPath $binary -Destination (Join-Path $delivery 'linden-leaf.exe') -Force

Write-Host "=== 4. Syncing to Desktop Target (Un-suffixed Legacy ONLY) ===" -ForegroundColor Cyan
$appDataTarget = Join-Path $env:LOCALAPPDATA 'Linden Leaf\linden-leaf.exe'
if (Test-Path -LiteralPath (Split-Path -Parent $appDataTarget)) {
    # Ensure any background linden processes from the un-suffixed path are cleanly terminated, NEVER kill v2.0.17
    Get-Process -Name "*linden*" -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -notlike "*v2.0.17*" } catch { $true }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
    Copy-Item -LiteralPath $binary -Destination $appDataTarget -Force
    $syncedInfo = Get-Item -LiteralPath $appDataTarget
    Write-Host "Synced to Desktop target: $($syncedInfo.FullName) ($($syncedInfo.LastWriteTime))" -ForegroundColor Green

    # Verify and ensure desktop shortcuts point to the un-suffixed target
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    foreach ($scName in @('Linden Leaf.lnk', 'Linden Leaf Tauri.lnk')) {
        $scPath = Join-Path $desktopPath $scName
        if (-not (Test-Path -LiteralPath $scPath)) {
            $sc = $shell.CreateShortcut($scPath)
            $sc.TargetPath = $appDataTarget
            $sc.WorkingDirectory = Split-Path -Parent $appDataTarget
            $sc.Save()
        } else {
            $sc = $shell.CreateShortcut($scPath)
            if ($sc.TargetPath -ne $appDataTarget) {
                $sc.TargetPath = $appDataTarget
                $sc.WorkingDirectory = Split-Path -Parent $appDataTarget
                $sc.Save()
            }
        }
        Write-Host "Desktop shortcut verified: $scPath -> $($sc.TargetPath)" -ForegroundColor Green
    }
}

$binInfo = Get-Item -LiteralPath $binary
$instInfo = Get-Item -LiteralPath $destination
$binHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash

Write-Host "Build Succeeded!" -ForegroundColor Green
[PSCustomObject]@{
    Status = "SUCCESS"
    Binary = $binary
    BinarySize = $binInfo.Length
    BinaryTime = $binInfo.LastWriteTime
    BinarySha256 = $binHash
    Installer = $destination
    InstallerSize = $instInfo.Length
    InstallerTime = $instInfo.LastWriteTime
} | Format-List
