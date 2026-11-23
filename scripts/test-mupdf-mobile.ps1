param(
    [string]$RealBook = '',
    [switch]$AndroidOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolchainRoot = if ($env:LINDEN_TOOLCHAINS_DIR) { $env:LINDEN_TOOLCHAINS_DIR } elseif ($env:LINDEN_TOOLCHAIN_ROOT) { $env:LINDEN_TOOLCHAIN_ROOT } else { '' }
$buildBase = if ($env:LINDEN_BUILD_ROOT) { $env:LINDEN_BUILD_ROOT } elseif ($env:LINDEN_BUILD_BASE) { $env:LINDEN_BUILD_BASE } else { Join-Path $projectRoot '.local\build' }
$testRoot = Join-Path $buildBase 'mupdf-mobile-tests'
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
$env:TEMP = $testRoot
$env:TMP = $testRoot
try {
    if (-not $AndroidOnly) {
        . (Join-Path $PSScriptRoot 'env.ps1')
        $units = @(
            (Join-Path $PSScriptRoot 'verify-mupdf-mobile.c'),
            (Join-Path $projectRoot 'src-tauri/native/ll_mupdf.c'),
            (Join-Path $projectRoot 'src-tauri/native/ll_mupdf_mobile.c')
        )
        $objects = @()
        foreach ($unit in $units) {
            $obj = Join-Path $testRoot (([IO.Path]::GetFileNameWithoutExtension($unit)) + '.obj')
            & cl.exe /nologo /c /O2 /MD /utf-8 "/I$env:LL_MUPDF_INCLUDE" "/I$(Join-Path $projectRoot 'src-tauri/native')" $unit "/Fo$obj"
            if ($LASTEXITCODE -ne 0) { throw "Native test compile failed: $unit" }
            $objects += $obj
        }
        $exe = Join-Path $testRoot 'verify-mupdf-mobile.exe'
        & cl.exe /nologo $objects "/Fe$exe" /link "/LIBPATH:$env:LL_MUPDF_LIB_DIR" libmupdf.lib libthirdparty.lib libresources.lib user32.lib gdi32.lib advapi32.lib shell32.lib ole32.lib comdlg32.lib ws2_32.lib crypt32.lib /INCREMENTAL:NO /LTCG:incremental "/IMPLIB:$(Join-Path $testRoot 'verify-mupdf-mobile.lib')"
        if ($LASTEXITCODE -ne 0) { throw 'Native test link failed' }
        $testArgs = @((Join-Path $testRoot 'mobile-fixture.pdf'))
        if ($RealBook) { $testArgs += (Resolve-Path -LiteralPath $RealBook).Path }
        Push-Location -LiteralPath $testRoot
        try { & $exe @testArgs } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Native mobile geometry/raster assertions failed' }
    }

    $sdkRoot = if ($env:ANDROID_HOME) {
        $env:ANDROID_HOME
    } elseif ($env:ANDROID_SDK_ROOT) {
        $env:ANDROID_SDK_ROOT
    } elseif ($toolchainRoot -and (Test-Path (Join-Path $toolchainRoot 'Android\sdk'))) {
        Join-Path $toolchainRoot 'Android\sdk'
    } else {
        Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    }

    $ndkRoot = if ($env:ANDROID_NDK_HOME) {
        $env:ANDROID_NDK_HOME
    } elseif ($env:NDK_HOME) {
        $env:NDK_HOME
    } elseif ($sdkRoot -and (Test-Path (Join-Path $sdkRoot 'ndk'))) {
        $preferredNdk = Join-Path $sdkRoot 'ndk\26.3.11579264'
        if (Test-Path $preferredNdk) {
            $preferredNdk
        } else {
            Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
        }
    } else {
        ''
    }

    if (-not $ndkRoot -or -not (Test-Path -LiteralPath $ndkRoot)) {
        throw "Android NDK not found. Set ANDROID_NDK_HOME or ANDROID_HOME (checked '$sdkRoot\ndk')."
    }

    $prebuiltDir = Join-Path $ndkRoot 'toolchains\llvm\prebuilt'
    $llvmRoot = if (Test-Path (Join-Path $prebuiltDir 'windows-x86_64')) {
        Join-Path $prebuiltDir 'windows-x86_64'
    } else {
        Get-ChildItem -LiteralPath $prebuiltDir -Directory -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
    }
    $clang = Join-Path $llvmRoot 'bin\clang.exe'
    if (-not (Test-Path -LiteralPath $clang)) { throw "NDK compiler not found: $clang" }
    $mupdfRoot = if ($env:MUPDF_ROOT) { $env:MUPDF_ROOT } else { Join-Path (Split-Path -Parent $projectRoot) 'mupdf-1.25.4-source' }
    foreach ($target in @('aarch64-linux-android24', 'x86_64-linux-android24')) {
        foreach ($name in @('ll_mupdf.c', 'll_mupdf_mobile.c')) {
            $object = Join-Path $testRoot "$target-$name.o"
            & $clang "--target=$target" "--sysroot=$(Join-Path $llvmRoot 'sysroot')" -std=c11 -c -O2 -ffunction-sections -fdata-sections -Wall -Wextra "-I$(Join-Path $mupdfRoot 'include')" "-I$(Join-Path $projectRoot 'src-tauri/native')" (Join-Path $projectRoot "src-tauri/native/$name") -o $object
            if ($LASTEXITCODE -ne 0) { throw "Android NDK object compile failed: $target / $name" }
            $header = & (Join-Path $llvmRoot 'bin\llvm-readelf.exe') --file-header $object
            $machine = if ($target.StartsWith('aarch64')) { 'AArch64' } else { 'Advanced Micro Devices X86-64' }
            if ($LASTEXITCODE -ne 0 -or -not ($header -match [regex]::Escape($machine))) {
                throw "Wrong Android object architecture: $target / $name"
            }
        }
        Write-Output "android_ndk_objects: PASS ($target; not a linked Android library or device execution)"
    }
} finally {
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
}
