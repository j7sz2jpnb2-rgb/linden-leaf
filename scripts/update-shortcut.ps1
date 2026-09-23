$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut('C:\Users\YONGHU\Desktop\Linden Leaf Tauri.lnk')
$sc.TargetPath = 'D:\LindenLeaf-Release\linden-leaf.exe'
$sc.WorkingDirectory = 'D:\LindenLeaf-Release'
$sc.Arguments = ''
$sc.IconLocation = 'D:\LindenLeaf-Dev\astra-mupdf-core\build\icon.ico,0'
$sc.Save()

Write-Output "Shortcut updated successfully!"
[PSCustomObject]@{
    TargetPath = $sc.TargetPath
    WorkingDirectory = $sc.WorkingDirectory
    Arguments = $sc.Arguments
    IconLocation = $sc.IconLocation
} | Format-List
