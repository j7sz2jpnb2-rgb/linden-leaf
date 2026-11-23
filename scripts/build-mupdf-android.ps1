# Build the ARM64 archives consumed by the shared Rust MuPDF driver.
param(
    [Parameter(Mandatory)][string]$NdkHome,
    [Parameter(Mandatory)][string]$BuildBase
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = if ($env:MUPDF_ROOT) { $env:MUPDF_ROOT } else {
    Join-Path (Split-Path -Parent $projectRoot) 'mupdf-1.25.4-source'
}
$sourceRoot = (Resolve-Path -LiteralPath $sourceRoot).Path.Replace('\', '/')
& git -C $sourceRoot apply --reverse --check (Join-Path $projectRoot 'patches/mupdf-1.25.4-security.patch')
if ($LASTEXITCODE -ne 0) { throw 'Android MuPDF requires the locally patched 1.25.4 source.' }

$nativeRoot = (Join-Path $BuildBase 'mupdf-android').Replace('\', '/')
$archiveDir = "$nativeRoot/obj/local/arm64-v8a"
$llvm = Join-Path $NdkHome 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$modules = @(
    'mupdf_core', 'mupdf_thirdparty_freetype', 'mupdf_thirdparty_gumbo',
    'mupdf_thirdparty_harfbuzz', 'mupdf_thirdparty_jbig2dec', 'mupdf_thirdparty_lcms2',
    'mupdf_thirdparty_libjpeg', 'mupdf_thirdparty_mujs', 'mupdf_thirdparty_openjpeg',
    'mupdf_thirdparty_extract'
)
$jobs = if ($env:CARGO_BUILD_JOBS) { [int]$env:CARGO_BUILD_JOBS } else { 2 }
$ndkArgs = @(
    '-C', $sourceRoot, '-j', $jobs, '--no-print-directory',
    'APP_PROJECT_PATH=null', "APP_BUILD_SCRIPT=$sourceRoot/platform/java/Android.mk",
    "NDK_OUT=$nativeRoot/obj", "NDK_LIBS_OUT=$nativeRoot/lib", 'APP_ABI=arm64-v8a',
    'APP_PLATFORM=android-24', 'APP_OPTIM=release', 'APP_SHORT_COMMANDS=true',
    'APP_STL=c++_static', "APP_MODULES=$($modules -join ' ')",
    'MUPDF_EXTRA_CFLAGS=-UTOFU_CJK -DTOFU_CJK_LANG'
)
& (Join-Path $NdkHome 'ndk-build.cmd') @ndkArgs
if ($LASTEXITCODE -ne 0) { throw 'Android MuPDF archive build failed.' }

# The upstream Android makefile includes Base14 fonts and omits CJK. Embed the
# two upstream CJK fallbacks without generating multi-megabyte C initializers.
$fontSources = foreach ($font in @('DroidSansFallback', 'DroidSansFallbackFull')) {
    $file = Get-Item -LiteralPath "$sourceRoot/resources/fonts/droid/$font.ttf"
    $symbol = "_binary_$($font)_ttf"
    '.p2align 2'
    ".global $symbol"
    "$($symbol):"
    ('.incbin "' + $file.FullName.Replace('\', '/') + '"')
    '.p2align 2'
    ".global $($symbol)_size"
    "$($symbol)_size:"
    ".long $($file.Length)"
}
$assembly = "$nativeRoot/cjk-fonts.S"
$object = "$nativeRoot/cjk-fonts.o"
$fontArchive = "$archiveDir/libmupdf_cjk_fonts.a"
@('.section .rodata', $fontSources) | Set-Content -LiteralPath $assembly -Encoding ascii
& (Join-Path $llvm 'aarch64-linux-android24-clang.cmd') -c $assembly -o $object
if ($LASTEXITCODE -ne 0) { throw 'Android MuPDF CJK font compilation failed.' }
& (Join-Path $llvm 'llvm-ar.exe') rcs $fontArchive $object
if ($LASTEXITCODE -ne 0) { throw 'Android MuPDF CJK font archive failed.' }

$env:LL_MUPDF_INCLUDE = "$sourceRoot/include"
$env:LL_MUPDF_ANDROID_LIB_DIR = $archiveDir
$env:LL_MUPDF_LIBS = ($modules + 'mupdf_cjk_fonts') -join ';'
