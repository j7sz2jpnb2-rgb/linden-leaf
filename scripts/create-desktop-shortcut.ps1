$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "Linden Leaf (最新源码预览).lnk"

$w = New-Object -ComObject WScript.Shell
$sc = $w.CreateShortcut($shortcutPath)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "`"D:\LindenLeaf-Dev\astra-mupdf-core\scripts\launch-preview.vbs`""
$sc.WorkingDirectory = "D:\LindenLeaf-Dev\astra-mupdf-core"
$sc.IconLocation = "D:\LindenLeaf-Dev\astra-mupdf-core\build\icon.ico,0"
$sc.Description = "Linden Leaf - 现代化全格式电子书阅读器 (最新源码实时预览)"
$sc.Save()

Write-Output "Successfully created shortcut at: $shortcutPath"
Write-Output "Target: $($sc.TargetPath) $($sc.Arguments)"
Write-Output "Icon: $($sc.IconLocation)"
