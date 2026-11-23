# scripts/build-mupdf.ps1
# Builds official MuPDF 1.25.4 static libraries for Linden Leaf on Windows x64.
# Set MUPDF_ROOT to override the MuPDF source directory.

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultMupdfRoot = Join-Path (Split-Path -Parent $projectRoot) "mupdf-1.25.4-source"
$sourceRoot = if ($env:MUPDF_ROOT) { $env:MUPDF_ROOT } else { $defaultMupdfRoot }
$slnPath = Join-Path $sourceRoot "platform\win32\mupdf.sln"

if (!(Test-Path $slnPath)) {
    Write-Error "MuPDF solution not found at: $slnPath (set MUPDF_ROOT if stored elsewhere)"
    exit 1
}

# Keep the pinned 1.25.4 source reproducibly patched before building its static libraries.
$versionHeader = Join-Path $sourceRoot 'include\mupdf\fitz\version.h'
if ((Get-Content -LiteralPath $versionHeader -Raw) -match '#define FZ_VERSION "1\.25\.4"') {
    $securityPatch = Join-Path $projectRoot 'patches\mupdf-1.25.4-security.patch'
    $reverseCheck = & git -C $sourceRoot apply --reverse --check $securityPatch 2>&1
    if ($LASTEXITCODE -ne 0) {
        & git -C $sourceRoot apply --check $securityPatch
        if ($LASTEXITCODE -ne 0) { throw 'MuPDF security patch does not match this source tree.' }
        & git -C $sourceRoot apply $securityPatch
        if ($LASTEXITCODE -ne 0) { throw 'Failed applying MuPDF security patch.' }
    }
}

# Locate MSBuild via LINDEN_TOOLCHAINS_DIR / LINDEN_TOOLCHAIN_ROOT, vswhere, standard VS paths, or PATH
$msbuildCandidates = @()
$toolchainRoot = if ($env:LINDEN_TOOLCHAINS_DIR) { $env:LINDEN_TOOLCHAINS_DIR } elseif ($env:LINDEN_TOOLCHAIN_ROOT) { $env:LINDEN_TOOLCHAIN_ROOT } else { "" }
if ($toolchainRoot) {
    $msbuildCandidates += (Join-Path $toolchainRoot "MSVC\MSBuild\Current\Bin\MSBuild.exe")
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsMsbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" 2>$null | Select-Object -First 1
    if ($vsMsbuild) { $msbuildCandidates += $vsMsbuild }
}
$msbuildCandidates += @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe",
    (Join-Path $projectRoot ".toolchains\MSVC\MSBuild\Current\Bin\MSBuild.exe")
)

$msbuild = $msbuildCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$msbuild) {
    $msbuildCmd = Get-Command msbuild -ErrorAction SilentlyContinue
    if ($msbuildCmd) { $msbuild = $msbuildCmd.Source }
}

if (!$msbuild) {
    Write-Error "MSBuild.exe not found. Please install Visual Studio Build Tools or add MSBuild to PATH."
    exit 1
}

Write-Host "[build-mupdf] Found MSBuild at: $msbuild" -ForegroundColor Green
Write-Host "[build-mupdf] Building MuPDF static libraries (libmupdf, libthirdparty, libresources) for x64 Release..."

$buildArgs = @(
    $slnPath,
    "/p:Configuration=Release",
    "/p:Platform=x64",
    "/p:PlatformToolset=v143",
    "/t:libmupdf;libthirdparty;libresources",
    "/m",
    "/v:minimal"
)

& $msbuild @buildArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "[build-mupdf] MSBuild failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$outputDir = Join-Path $sourceRoot "platform\win32\x64\Release"
$requiredLibs = @("libmupdf.lib", "libthirdparty.lib", "libresources.lib")
$missing = @()

foreach ($lib in $requiredLibs) {
    $p = Join-Path $outputDir $lib
    if (Test-Path $p) {
        $size = (Get-Item $p).Length
        Write-Host "  [OK] $lib ($size bytes)" -ForegroundColor Green
    } else {
        $missing += $lib
        Write-Host "  [MISSING] $lib" -ForegroundColor Red
    }
}

if ($missing.Count -gt 0) {
    Write-Error "[build-mupdf] Build completed but required libraries are missing: $($missing -join ', ')"
    exit 1
}

Write-Host "[build-mupdf] Successfully verified MuPDF x64 libraries in $outputDir" -ForegroundColor Green
