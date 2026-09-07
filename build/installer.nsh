; NSIS Custom Installer / Uninstaller Script for Linden Leaf
; Provides interactive option to preserve or wipe user library & reading data upon uninstall

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "是否保留您的本地书库、划线笔记与阅读统计数据？`r`n`r`n【是】：保留全部个人阅读数据与书库（推荐，升级或重装无缝继承）；`r`n【否】：彻底清除所有本地数据与缓存。" /SD IDYES IDYES keepData
  
  ; User chose NO (Delete User Data)
  DetailPrint "正在清理用户个人数据与本地书库..."
  RMDir /r "$APPDATA\Linden Leaf"
  RMDir /r "$APPDATA\linden-leaf"
  RMDir /r "$LOCALAPPDATA\Linden Leaf"
  RMDir /r "$LOCALAPPDATA\linden-leaf"
  RMDir /r "$LOCALAPPDATA\linden-leaf-updater"
  RMDir /r "$LOCALAPPDATA\Linden-leaf-updater"
  Goto doneUninstall

keepData:
  DetailPrint "已保留用户个人数据与本地书库。"

doneUninstall:
!macroend