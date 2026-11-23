param([string]$VerifierProject = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$verifierRoot = (Resolve-Path -LiteralPath $VerifierProject).Path
. (Join-Path $verifierRoot 'scripts/env.ps1')
$verifierBuild = Join-Path $env:CARGO_TARGET_DIR 'reader-verifier'
New-Item -ItemType Directory -Force -Path $verifierBuild | Out-Null
$verifierSources = @(
    @{ Source = (Join-Path $verifierRoot 'scripts/verify-real-books.c'); Object = (Join-Path $verifierBuild 'verify-real-books.obj') },
    @{ Source = (Join-Path $verifierRoot 'src-tauri/native/ll_mupdf.c'); Object = (Join-Path $verifierBuild 'll_mupdf.obj') }
)
foreach ($unit in $verifierSources) {
    & cl.exe /nologo /c /O2 /MD /utf-8 "/I$env:LL_MUPDF_INCLUDE" "/I$(Join-Path $verifierRoot 'src-tauri/native')" $unit.Source "/Fo$($unit.Object)"
    if ($LASTEXITCODE -ne 0) { throw "Native verifier compile failed: $($unit.Source)" }
}
$verifierExe = Join-Path $verifierRoot 'scripts/verify-real-books.exe'
& cl.exe /nologo ($verifierSources.Object) "/Fe$verifierExe" /link "/LIBPATH:$env:LL_MUPDF_LIB_DIR" libmupdf.lib libthirdparty.lib libresources.lib user32.lib gdi32.lib advapi32.lib shell32.lib ole32.lib comdlg32.lib ws2_32.lib crypt32.lib /INCREMENTAL:NO /LTCG "/IMPLIB:$(Join-Path $verifierBuild 'verify-real-books.lib')"
if ($LASTEXITCODE -ne 0) { throw 'Native verifier link failed' }
Write-Output "Built current native verifier: $verifierExe"
