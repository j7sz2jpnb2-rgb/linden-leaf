# scripts/env.ps1
# Project-level environment configuration for Linden Leaf (PowerShell)
# Configures PATH and environment variables for the current session without modifying global system environment.

$projectRoot = Split-Path -Parent $PSScriptRoot

# Configure PATH with discovered local toolchains (Git, Node, PNPM, Cargo)
$toolPaths = @(
    "D:\LindenLeaf-Toolchains\cargo\bin",
    "C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd",
    "C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin",
    "C:\Users\YONGHU\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback"
)

foreach ($tp in $toolPaths) {
    if ((Test-Path $tp) -and ($env:PATH -notlike "*$tp*")) {
        $env:PATH = "$tp;" + $env:PATH
    }
}

# Project caches and toolchains on D: drive
$env:PNPM_HOME = "D:\LindenLeaf-Dev\.pnpm-store"
$env:RUSTUP_HOME = "D:\LindenLeaf-Toolchains\rustup"
$env:CARGO_HOME = "D:\LindenLeaf-Toolchains\cargo"
$env:CARGO_TARGET_DIR = "D:\LindenLeaf-Build\target"
$env:LINDEN_NATIVE_CACHE_DIR = "D:\LindenLeaf-Data\development\pdf-native"

Write-Host "[env.ps1] Project session environment configured." -ForegroundColor Green
Write-Host "  Project root: $projectRoot"
Write-Host "  Git: $(Get-Command git -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Node: $(Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  PNPM: $(Get-Command pnpm -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Rustc: $(Get-Command rustc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Host "  Cargo: $(Get-Command cargo -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
