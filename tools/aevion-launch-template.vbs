' Aevion launcher shim (generated from tools/aevion-launch-template.vbs).
'
' A Windows shortcut that points straight at powershell.exe flashes a console
' window on every launch. Running it through wscript with a hidden window style
' means there is no console at all - the app window is the only thing you see.
'
' The installer replaces __LAUNCH__ with the absolute path to launch.ps1.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""__LAUNCH__""", 0, False
