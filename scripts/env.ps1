# scripts/env.ps1
# Project-level environment configuration for Linden Leaf (PowerShell)
# Configures PATH, INCLUDE, LIB, and environment variables for the current session without modifying global system environment.
# Optional overrides: LINDEN_TOOLCHAINS_DIR (or LINDEN_TOOLCHAIN_ROOT), LINDEN_DEV_ROOT, LINDEN_BUILD_ROOT,
# LINDEN_MSVC_DIR, LINDEN_WINSDK_DIR, LINDEN_WINSDK_VERSION, MUPDF_ROOT, LL_MUPDF_INCLUDE, LL_MUPDF_LIB_DIR

$projectRoot = Split-Path -Parent $PSScriptRoot

$toolchainRoot = if ($env:LINDEN_TOOLCHAINS_DIR) { $env:LINDEN_TOOLCHAINS_DIR } elseif ($env:LINDEN_TOOLCHAIN_ROOT) { $env:LINDEN_TOOLCHAIN_ROOT } else { "" }
$devRoot = if ($env:LINDEN_DEV_ROOT) { $env:LINDEN_DEV_ROOT } else { Split-Path -Parent $projectRoot }
$buildRoot = if ($env:LINDEN_BUILD_ROOT) { $env:LINDEN_BUILD_ROOT } elseif ($env:LINDEN_BUILD_BASE) { $env:LINDEN_BUILD_BASE } else { Join-Path $projectRoot ".local\build" }

$toolPaths = @()
if ($toolchainRoot) {
    $toolPaths += (Join-Path $toolchainRoot "cargo\bin")
}
if ($env:CARGO_HOME) {
    $toolPaths += (Join-Path $env:CARGO_HOME "bin")
} elseif (Test-Path (Join-Path $env:USERPROFILE ".cargo\bin")) {
    $toolPaths += (Join-Path $env:USERPROFILE ".cargo\bin")
}

# Discover MSVC Toolset via LINDEN_MSVC_DIR, vswhere.exe, or optional LINDEN_TOOLCHAINS_DIR
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$msvcToolsetDir = ""
if ($env:LINDEN_MSVC_DIR -and (Test-Path $env:LINDEN_MSVC_DIR)) {
    $msvcToolsetDir = $env:LINDEN_MSVC_DIR
} elseif ($env:VCToolsInstallDir -and (Test-Path $env:VCToolsInstallDir)) {
    $msvcToolsetDir = $env:VCToolsInstallDir.TrimEnd('\', '/')
} else {
    $vsRootCandidates = @()
    if (Test-Path $vswhere) {
        $detectedVs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1
        if ($detectedVs) { $vsRootCandidates += $detectedVs }
    }
    if ($toolchainRoot) {
        $vsRootCandidates += (Join-Path $toolchainRoot "MSVC")
    }
    foreach ($vsRoot in $vsRootCandidates) {
        $msvcBase = Join-Path $vsRoot "VC\Tools\MSVC"
        if (Test-Path $msvcBase) {
            $latestToolset = Get-ChildItem -LiteralPath $msvcBase -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
            if ($latestToolset) {
                $msvcToolsetDir = $latestToolset.FullName
                break
            }
        }
    }
}

# Discover Windows SDK (env override -> registry/standard Windows Kits\10)
$windowsSdkDir = if ($env:LINDEN_WINSDK_DIR) {
    $env:LINDEN_WINSDK_DIR
} elseif ($env:WindowsSdkDir) {
    $env:WindowsSdkDir.TrimEnd('\', '/')
} else {
    "${env:ProgramFiles(x86)}\Windows Kits\10"
}

$windowsSdkVersion = ""
if ($env:LINDEN_WINSDK_VERSION) {
    $windowsSdkVersion = $env:LINDEN_WINSDK_VERSION
} elseif ($env:WindowsSDKVersion) {
    $windowsSdkVersion = $env:WindowsSDKVersion.TrimEnd('\', '/')
} elseif (Test-Path (Join-Path $windowsSdkDir "Include")) {
    $latestSdk = Get-ChildItem -LiteralPath (Join-Path $windowsSdkDir "Include") -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.' } |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($latestSdk) { $windowsSdkVersion = $latestSdk.Name }
}

$msbuildBin = ""
if ($vswhere -and (Test-Path $vswhere)) {
    $detectedMsbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" 2>$null | Select-Object -First 1
    if ($detectedMsbuild) { $msbuildBin = Split-Path -Parent $detectedMsbuild }
}
if (-not $msbuildBin -and $toolchainRoot) {
    $candidateMsbuildBin = Join-Path $toolchainRoot "MSVC\MSBuild\Current\Bin"
    if (Test-Path $candidateMsbuildBin) { $msbuildBin = $candidateMsbuildBin }
}

if ($msvcToolsetDir -and (Test-Path "$msvcToolsetDir\bin\Hostx64\x64")) {
    $toolPaths += "$msvcToolsetDir\bin\Hostx64\x64"
}
if ($windowsSdkDir -and $windowsSdkVersion -and (Test-Path "$windowsSdkDir\bin\$windowsSdkVersion\x64")) {
    $toolPaths += "$windowsSdkDir\bin\$windowsSdkVersion\x64"
}
if ($msbuildBin -and (Test-Path $msbuildBin)) {
    $toolPaths += $msbuildBin
}

foreach ($tp in $toolPaths) {
    if ($tp -and (Test-Path $tp) -and ($env:PATH -notlike "*$tp*")) {
        $env:PATH = "$tp;" + $env:PATH
    }
}

# Set INCLUDE, LIB, and LIBPATH for MSVC x64 C/C++ compilation when not already initialized
$includePaths = @()
if ($msvcToolsetDir) { $includePaths += "$msvcToolsetDir\include" }
if ($windowsSdkDir -and $windowsSdkVersion) {
    $includePaths += @(
        "$windowsSdkDir\Include\$windowsSdkVersion\ucrt",
        "$windowsSdkDir\Include\$windowsSdkVersion\shared",
        "$windowsSdkDir\Include\$windowsSdkVersion\um",
        "$windowsSdkDir\Include\$windowsSdkVersion\winrt",
        "$windowsSdkDir\Include\$windowsSdkVersion\cppwinrt"
    )
}
$validIncludes = $includePaths | Where-Object { $_ -and (Test-Path $_) }
if ($validIncludes.Count -gt 0) {
    $env:INCLUDE = $validIncludes -join ";"
}

$libPaths = @()
if ($msvcToolsetDir) { $libPaths += "$msvcToolsetDir\lib\x64" }
if ($windowsSdkDir -and $windowsSdkVersion) {
    $libPaths += @(
        "$windowsSdkDir\Lib\$windowsSdkVersion\ucrt\x64",
        "$windowsSdkDir\Lib\$windowsSdkVersion\um\x64"
    )
}
$validLibs = $libPaths | Where-Object { $_ -and (Test-Path $_) }
if ($validLibs.Count -gt 0) {
    $env:LIB = $validLibs -join ";"
}
if ($msvcToolsetDir -and (Test-Path "$msvcToolsetDir\lib\x64")) {
    $env:LIBPATH = "$msvcToolsetDir\lib\x64"
}

# Project caches and toolchains (respect pre-set env vars or local portable layout)
if (-not $env:PNPM_HOME -and (Test-Path (Join-Path $devRoot ".pnpm-store"))) {
    $env:PNPM_HOME = Join-Path $devRoot ".pnpm-store"
}
if (-not $env:RUSTUP_HOME -and $toolchainRoot -and (Test-Path (Join-Path $toolchainRoot "rustup"))) {
    $env:RUSTUP_HOME = Join-Path $toolchainRoot "rustup"
}
if (-not $env:CARGO_HOME -and $toolchainRoot -and (Test-Path (Join-Path $toolchainRoot "cargo"))) {
    $env:CARGO_HOME = Join-Path $toolchainRoot "cargo"
}
if (-not $env:CARGO_TARGET_DIR) {
    $env:CARGO_TARGET_DIR = Join-Path $buildRoot "target"
}
if (-not $env:LINDEN_NATIVE_CACHE_DIR) {
    $env:LINDEN_NATIVE_CACHE_DIR = Join-Path $projectRoot ".local\pdf-native"
}

# MuPDF native bridge configuration (override via MUPDF_ROOT / LL_MUPDF_INCLUDE / LL_MUPDF_LIB_DIR)
$mupdfRoot = if ($env:MUPDF_ROOT) { $env:MUPDF_ROOT } else { Join-Path $devRoot "mupdf-1.25.4-source" }
$mupdfInclude = if ($env:LL_MUPDF_INCLUDE) { $env:LL_MUPDF_INCLUDE } else { Join-Path $mupdfRoot "include" }
$mupdfLibDir = if ($env:LL_MUPDF_LIB_DIR) { $env:LL_MUPDF_LIB_DIR } else { Join-Path $mupdfRoot "platform\win32\x64\Release" }
if (Test-Path $mupdfInclude) {
    $env:LL_MUPDF_INCLUDE = $mupdfInclude
}
if (Test-Path $mupdfLibDir) {
    $env:LL_MUPDF_LIB_DIR = $mupdfLibDir
}
if (-not $env:LL_MUPDF_LIBS) {
    $env:LL_MUPDF_LIBS = "libmupdf;libthirdparty;libresources"
}
if (-not $env:LL_REQUIRE_NATIVE_MUPDF -and $env:LL_MUPDF_INCLUDE -and $env:LL_MUPDF_LIB_DIR) {
    $env:LL_REQUIRE_NATIVE_MUPDF = "1"
}

Write-Host "[env.ps1] Project session environment configured." -ForegroundColor Green
Write-Host "  Project root: $projectRoot"
Write-Host "  Git: $(Get-Command git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Node: $(Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  PNPM: $(Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Rustc: $(Get-Command rustc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Cargo: $(Get-Command cargo -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Linker: $(Get-Command link -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  MSBuild: $(Get-Command msbuild -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  MSVC Toolset: $msvcToolsetDir"
Write-Host "  Windows SDK: $windowsSdkDir ($windowsSdkVersion)"
Write-Host "  MuPDF Include: $env:LL_MUPDF_INCLUDE"
Write-Host "  MuPDF Lib Dir: $env:LL_MUPDF_LIB_DIR"
Write-Host "  MuPDF Libs: $env:LL_MUPDF_LIBS"
Write-Host "  Require Native: $env:LL_REQUIRE_NATIVE_MUPDF"
