# scripts/launch-preview.ps1
$port = 18420
$url = "http://127.0.0.1:$port/index.html"
$rootDir = (Get-Item $PSScriptRoot).Parent.FullName

# 1. Check if preview server is already running
$isRunning = $false
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 -ErrorAction Stop
    if ($resp.ok) { $isRunning = $true }
} catch {}

# 2. If not running, start it silently
if (-not $isRunning) {
    $nodeCmd = "C:\Users\YONGHU\.gemini\antigravity\bin\node.cmd"
    if (Test-Path $nodeCmd) {
        Start-Process "cmd.exe" -ArgumentList "/c `"$nodeCmd`" `"$rootDir\scripts\preview-server.mjs`"" -WorkingDirectory $rootDir -WindowStyle Hidden
    } else {
        Start-Process "cmd.exe" -ArgumentList "/c node `"$rootDir\scripts\preview-server.mjs`"" -WorkingDirectory $rootDir -WindowStyle Hidden
    }
    Start-Sleep -Milliseconds 800
}

# 3. Find Edge and launch in standalone app mode
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edgePath)) {
    $edgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}

if (Test-Path $edgePath) {
    Start-Process $edgePath -ArgumentList "--app=$url"
} else {
    Start-Process $url
}
