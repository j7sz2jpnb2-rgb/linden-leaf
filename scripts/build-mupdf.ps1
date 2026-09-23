# scripts/build-mupdf.ps1
# Builds official MuPDF 1.25.4 static libraries for Linden Leaf on Windows x64.
# Requires MSVC Build Tools installed in D:\LindenLeaf-Toolchains\MSVC or system path.

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = "D:\LindenLeaf-Dev\mupdf-1.25.4-source"
$slnPath = Join-Path $sourceRoot "platform\win32\mupdf.sln"

if (!(Test-Path $slnPath)) {
    Write-Error "MuPDF solution not found at: $slnPath"
    exit 1
}

# Locate MSBuild
$msbuildCandidates = @(
    "D:\LindenLeaf-Toolchains\MSVC\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe"
)

$msbuild = $msbuildCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$msbuild) {
    $msbuildCmd = Get-Command msbuild -ErrorAction SilentlyContinue
    if ($msbuildCmd) { $msbuild = $msbuildCmd.Source }
}

if (!$msbuild) {
    Write-Error "MSBuild.exe not found. Please install MSVC Build Tools to D:\LindenLeaf-Toolchains\MSVC."
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
