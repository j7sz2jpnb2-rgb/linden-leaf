# scripts/build-windows-current.ps1
# Build script for Linden Leaf Windows release (NSIS) using MSVC and Tauri

param(
    [switch]$Deploy = $false,
    [string]$Version = '1.0.0',
    [switch]$NoBundle = $false,
    [switch]$BundleOnly = $false
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
. (Join-Path $projectRoot 'scripts\env.ps1')

$localNsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
if (Test-Path $localNsis) { $env:PATH = "$localNsis;$env:PATH" }

foreach ($variableName in @(
    'CC_aarch64_linux_android','CXX_aarch64_linux_android','AR_aarch64_linux_android',
    'RANLIB_aarch64_linux_android','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER',
    'RUSTFLAGS','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_HOME','NDK_HOME'
)) {
    [Environment]::SetEnvironmentVariable($variableName, $null, 'Process')
}

$tempRoot = Join-Path $projectRoot "build-temp-$Version"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:CARGO_BUILD_JOBS = '1'

$spaceTarget = if ($env:CARGO_TARGET_DIR -and [IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) { $env:CARGO_TARGET_DIR } else { $projectRoot }
$driveName = [IO.Path]::GetPathRoot($spaceTarget).TrimEnd(':', '\', '/')
$targetDrive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
if ($targetDrive -and $targetDrive.Free -lt 1.0GB) {
    throw "Insufficient free space on drive ${driveName}: (< 1.0 GB)."
}

# Rebuild the patched native library incrementally before linking a new executable.
if (-not $BundleOnly) {
    & (Join-Path $projectRoot 'scripts\build-mupdf.ps1')
}

# Tauri beforeBuildCommand prepares fresh frontend resources once. BundleOnly uses the existing release executable.

$delivery = if ($env:LINDEN_DELIVERY_DIR) { Join-Path $env:LINDEN_DELIVERY_DIR "windows-$Version-mupdf" } else { Join-Path $projectRoot "deliveries\windows-$Version-mupdf" }
$name = "Linden Leaf_${Version}_x64-setup.exe"
$destination = Join-Path $delivery $name

$startedAt = Get-Date
$tauriMain = Join-Path $projectRoot 'node_modules\@tauri-apps\cli\main.js'

if ($NoBundle) {
    Write-Host "=== 2. Building Tauri Windows Release binary (--no-bundle) ===" -ForegroundColor Cyan
    & node -e "require(process.argv[1]).run(process.argv.slice(2)).catch(err => { console.error(err); process.exit(1); })" $tauriMain build --target x86_64-pc-windows-msvc --no-bundle
} elseif ($BundleOnly) {
    Write-Host "=== 2. Packaging NSIS installer (--bundles nsis) ===" -ForegroundColor Cyan
    & node -e "require(process.argv[1]).run(process.argv.slice(2)).catch(err => { console.error(err); process.exit(1); })" $tauriMain bundle --target x86_64-pc-windows-msvc --bundles nsis
} else {
    Write-Host "=== 2. Building Tauri Windows Release binary & NSIS package ===" -ForegroundColor Cyan
    & node -e "require(process.argv[1]).run(process.argv.slice(2)).catch(err => { console.error(err); process.exit(1); })" $tauriMain build --target x86_64-pc-windows-msvc --bundles nsis
}
if ($LASTEXITCODE -ne 0) {
    throw "Tauri build/bundle failed with exit code $LASTEXITCODE"
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
if (-not $BundleOnly) {
    if ((Get-Item -LiteralPath $binary).LastWriteTime -lt $startedAt.AddMinutes(-30)) {
        throw "Built binary was not updated (timestamp older than build start time: $startedAt)"
    }
}
if ((Get-Item -LiteralPath $binary).VersionInfo.ProductVersion -ne $Version) {
    throw "Built binary version mismatch: $((Get-Item -LiteralPath $binary).VersionInfo.ProductVersion) (expected $Version)"
}

if (-not $NoBundle) {
    if (-not $installer -or -not (Test-Path -LiteralPath $installer)) {
        throw "Expected NSIS installer is missing at $installer"
    }
    if ((Get-Item -LiteralPath $installer).LastWriteTime -lt $startedAt.AddMinutes(-30)) {
        throw "Installer predates this build (timestamp older than build start time: $startedAt)"
    }
}

Write-Host "=== 3. Delivering release package ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $delivery | Out-Null
if (-not $NoBundle -and $installer) {
    Copy-Item -LiteralPath $installer -Destination $destination -Force
}
Copy-Item -LiteralPath $binary -Destination (Join-Path $delivery 'linden-leaf.exe') -Force
$extSrc = Join-Path $projectRoot 'extensions\chromium-companion'
if (Test-Path -LiteralPath $extSrc) {
    $extDest = Join-Path $delivery 'extensions\chromium-companion'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $extDest) | Out-Null
    Copy-Item -Path $extSrc -Destination (Split-Path -Parent $extDest) -Recurse -Force
}

if ($Deploy) {
    Write-Host "=== 4. Syncing to Desktop Target (-Deploy requested) ===" -ForegroundColor Cyan
    $appDataTarget = Join-Path $env:LOCALAPPDATA 'Linden Leaf\linden-leaf.exe'
    if (Test-Path -LiteralPath (Split-Path -Parent $appDataTarget)) {
        Get-Process -Name "linden-leaf" -ErrorAction SilentlyContinue | Where-Object {
            try { $_.Path -eq $appDataTarget } catch { $false }
        } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        Copy-Item -LiteralPath $binary -Destination $appDataTarget -Force
        $syncedInfo = Get-Item -LiteralPath $appDataTarget
        Write-Host "Synced to Desktop target: $($syncedInfo.FullName) ($($syncedInfo.LastWriteTime))" -ForegroundColor Green

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
} else {
    Write-Host "=== 4. Skipping Deployment (Default Candidate Build Mode; pass -Deploy to sync to %LOCALAPPDATA%) ===" -ForegroundColor Yellow
}

$binInfo = Get-Item -LiteralPath $binary
$instInfo = if (-not $NoBundle) { Get-Item -LiteralPath $destination } else { $null }
$binHash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash

Write-Host "Build Succeeded!" -ForegroundColor Green
[PSCustomObject]@{
    Status = "SUCCESS"
    Binary = $binary
    BinarySize = $binInfo.Length
    BinaryTime = $binInfo.LastWriteTime
    BinarySha256 = $binHash
    Installer = if ($instInfo) { $destination } else { $null }
    InstallerSize = if ($instInfo) { $instInfo.Length } else { $null }
    InstallerTime = if ($instInfo) { $instInfo.LastWriteTime } else { $null }
} | Format-List
