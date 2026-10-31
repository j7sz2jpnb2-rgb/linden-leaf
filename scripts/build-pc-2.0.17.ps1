$ErrorActionPreference = 'Stop'
$projectRoot = 'D:\LindenLeaf-Dev\astra-mupdf-core'
Set-Location -LiteralPath $projectRoot
. (Join-Path $projectRoot 'scripts\env.ps1')
foreach ($variableName in @('CC_aarch64_linux_android','CXX_aarch64_linux_android','AR_aarch64_linux_android','RANLIB_aarch64_linux_android','CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER','RUSTFLAGS','ANDROID_HOME','ANDROID_SDK_ROOT','ANDROID_NDK_HOME','NDK_HOME')) {
    [Environment]::SetEnvironmentVariable($variableName, $null, 'Process')
}
$tempRoot = 'D:\LindenLeaf-Dev\astra-mupdf-core\build-temp-2.0.17'
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:LINDEN_SKIP_RESOURCE_HASH = '1'
$env:CARGO_BUILD_JOBS = '1'
if ((Get-PSDrive D).Free -lt 1.25GB) { throw 'Insufficient D: space for incremental build; no automatic deletion.' }
$delivery = 'D:\LindenLeaf-Deliveries\2026-10-21\windows-2.0.17'
$name = 'Linden Leaf_2.0.17_x64-setup.exe'
$destination = Join-Path $delivery $name
if (Test-Path -LiteralPath $destination) { throw 'This delivery already exists; refusing to overwrite.' }
$startedAt = Get-Date
& pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed: $LASTEXITCODE" }
$installer = Join-Path $env:CARGO_TARGET_DIR "x86_64-pc-windows-msvc\release\bundle\nsis\$name"
$binary = Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc\release\linden-leaf.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Expected installer is missing.' }
if ((Get-Item -LiteralPath $installer).LastWriteTime -lt $startedAt) { throw 'Installer predates this build.' }
if ((Get-Item -LiteralPath $binary).VersionInfo.ProductVersion -ne '2.0.17') { throw 'Built binary version mismatch.' }
New-Item -ItemType Directory -Force -Path $delivery | Out-Null
Copy-Item -LiteralPath $installer -Destination $destination
Get-Item -LiteralPath $destination | Select-Object FullName,Length,LastWriteTime | ConvertTo-Json
