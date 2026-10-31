$ErrorActionPreference = 'Stop'
$installer = 'D:\LindenLeaf-Deliveries\2026-10-21\windows-2.0.17\Linden Leaf_2.0.17_x64-setup.exe'
$installed = 'C:\Users\YONGHU\AppData\Local\Linden Leaf\linden-leaf.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Latest installer is not ready.' }
if (@(Get-Process -Name linden-leaf -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'Reader is running. Close it normally before this update; no forced termination.'
}
$installProcess = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if ($installProcess.ExitCode -ne 0) { throw "Installer failed: $($installProcess.ExitCode)" }
$file = Get-Item -LiteralPath $installed
if ($file.VersionInfo.ProductVersion -ne '2.0.17') { throw "Installed version mismatch: $($file.VersionInfo.ProductVersion)" }
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcuts = @('Linden Leaf.lnk', 'Linden Leaf Tauri.lnk')
$rows = foreach ($name in $shortcuts) {
    $shortcut = Join-Path $desktop $name
    if (-not (Test-Path -LiteralPath $shortcut)) {
        # Create shortcut if missing
        $sc = $shell.CreateShortcut($shortcut)
        $sc.TargetPath = $installed
        $sc.WorkingDirectory = [System.IO.Path]::GetDirectoryName($installed)
        $sc.Save()
    }
    $target = $shell.CreateShortcut($shortcut).TargetPath
    [PSCustomObject]@{ Shortcut=$shortcut; Target=$target; ProductVersion=(Get-Item -LiteralPath $target).VersionInfo.ProductVersion }
}
$result = [PSCustomObject]@{ Installed=$installed; ProductVersion=$file.VersionInfo.ProductVersion; Bytes=$file.Length; Shortcuts=$rows }
$result | ConvertTo-Json -Depth 4
