' Runs jarvis-switch.ps1 without flashing a console window.
' This is what the "JARVIS - ON / OFF" desktop shortcut points at.
Dim here
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\jarvis-switch.ps1""", 0, False
