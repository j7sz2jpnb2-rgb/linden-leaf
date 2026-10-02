' scripts/launch-preview.vbs
' Launches Linden Leaf preview server silently and opens Edge in standalone app mode.

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)

cmdPath = rootDir & "\启动最新源码预览.cmd"
If fso.FileExists(cmdPath) Then
    WshShell.Run "cmd.exe /c """ & cmdPath & """", 0, False
Else
    WshShell.Run "http://127.0.0.1:18420/index.html", 1, False
End If
