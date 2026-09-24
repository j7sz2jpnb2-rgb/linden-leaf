param(
    [string]$TargetPath = 'D:\LindenLeaf-Candidate\linden-leaf.exe'
)

$workingDir = Split-Path -Parent $TargetPath
$iconPath = Join-Path $workingDir 'icon.ico'
if (-not (Test-Path $iconPath)) {
    $iconPath = 'D:\LindenLeaf-Dev\astra-mupdf-core\build\icon.ico'
}

$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut('C:\Users\YONGHU\Desktop\Linden Leaf Tauri.lnk')
$sc.TargetPath = $TargetPath
$sc.WorkingDirectory = $workingDir
$sc.Arguments = ''
$sc.IconLocation = "$iconPath,0"
$sc.Save()

Write-Output "Shortcut updated successfully!"
[PSCustomObject]@{
    ShortcutPath     = 'C:\Users\YONGHU\Desktop\Linden Leaf Tauri.lnk'
    TargetPath       = $sc.TargetPath
    WorkingDirectory = $sc.WorkingDirectory
    Arguments        = $sc.Arguments
    IconLocation     = $sc.IconLocation
} | Format-List
