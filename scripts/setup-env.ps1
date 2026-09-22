# scripts/setup-env.ps1
# Linden Leaf (Universal Reader) Tauri 宿主机编译环境一键安装与验证脚本

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Linden Leaf Tauri 宿主机编译环境自动化检测与配置向导    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. 检查 Winget
$hasWinget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $hasWinget) {
    Write-Warning "未检测到 winget 包管理器，请通过 Windows 应用商店安装 '应用安装程序' (App Installer)。"
} else {
    Write-Host "[OK] 检测到 Winget 包管理器" -ForegroundColor Green
}

# 2. 检查 Rust 工具链 (cargo & rustc)
$hasCargo = Get-Command cargo -ErrorAction SilentlyContinue
$hasRustc = Get-Command rustc -ErrorAction SilentlyContinue

if (-not $hasCargo -or -not $hasRustc) {
    Write-Host "[!] 未检测到 Rust 工具链，准备通过 winget 自动安装 Rustup..." -ForegroundColor Yellow
    winget install --id Rustlang.Rustup -e --silent --accept-package-agreements --accept-source-agreements
    
    # 刷新环境变量
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
    Write-Host "正在设置 stable-x86_64-pc-windows-msvc 为默认工具链..." -ForegroundColor Yellow
    rustup default stable-x86_64-pc-windows-msvc
} else {
    $cargoVer = cargo -V
    Write-Host "[OK] 检测到 Rust 工具链: $cargoVer" -ForegroundColor Green
}

# 3. 检查 Visual Studio C++ 构建工具 (MSVC cl.exe / cmake)
$hasCl = Get-Command cl -ErrorAction SilentlyContinue
$hasCmake = Get-Command cmake -ErrorAction SilentlyContinue

if (-not $hasCl) {
    Write-Host "[!] 未检测到 MSVC C++ 编译器 (cl.exe)。" -ForegroundColor Yellow
    Write-Host "    Tauri 2.0 与 MuPDF 本地编译需要 Visual Studio 2022 C++ 生成工具。" -ForegroundColor Yellow
    Write-Host "    正在通过 winget 安装 Visual Studio 2022 Build Tools (包含 C++ 桌面工作负载)..." -ForegroundColor Yellow
    
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --silent `
        --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
} else {
    Write-Host "[OK] 检测到 MSVC C++ 编译器" -ForegroundColor Green
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "环境配置完成！请重启当前 PowerShell 终端使环境变量生效。" -ForegroundColor Green
Write-Host "后续验证命令: cargo -V ; rustc -V" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
