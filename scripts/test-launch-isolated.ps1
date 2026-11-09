$ErrorActionPreference = 'Stop'
$testDir = "D:\LindenLeaf-Build\test-isolated-profile"
New-Item -ItemType Directory -Force -Path $testDir | Out-Null
$env:WEBVIEW2_USER_DATA_FOLDER = (Join-Path $testDir "webview2")
$env:LINDEN_NATIVE_CACHE_DIR = (Join-Path $testDir "pdf-native")
$env:LINDEN_APP_CONFIG_DIR = (Join-Path $testDir "config")
$env:LINDEN_APP_DATA_DIR = (Join-Path $testDir "data")
$env:LINDEN_DISABLE_AUTO_SYNC = "1"
$env:LINDEN_SINGLE_INSTANCE_KEY = "linden-leaf-isolated-$([System.Guid]::NewGuid().ToString('N'))"

$exePath = (Resolve-Path "deliveries\windows-1.0.0-mupdf\linden-leaf.exe").Path
Write-Host "Starting candidate EXE: $exePath"
$p = Start-Process -FilePath $exePath -PassThru
Start-Sleep -Seconds 5

$proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
$running = ($null -ne $proc -and -not $proc.HasExited)
$wsMB = 0
$privMB = 0
if ($running) {
    $wsMB = [math]::Round($proc.WorkingSet64 / 1MB, 2)
    $privMB = [math]::Round($proc.PrivateMemorySize64 / 1MB, 2)
    Write-Host "Process running stably! WorkingSet: ${wsMB} MB, PrivateMemory: ${privMB} MB"
    Stop-Process -Id $p.Id -Force
} else {
    Write-Host "Process exited early with code: $($p.ExitCode)"
}

[PSCustomObject]@{
    CandidateExe = $exePath
    Started = $true
    StillRunningAfter5s = $running
    WorkingSetMB = $wsMB
    PrivateMemoryMB = $privMB
    IsolatedProfileCreated = (Test-Path (Join-Path $testDir "webview2"))
    Version = (Get-Item $exePath).VersionInfo.ProductVersion
    VerificationScope = "Process presence after 5s under isolated profile/config; does NOT prove zero memory leak or clean shutdown"
} | Format-List
