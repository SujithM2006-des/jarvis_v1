' Runs popup-switch.ps1 without flashing a console window.
' This is what the "JARVIS Popup - ON / OFF" desktop shortcut points at.
Dim here, args, i
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\popup-switch.ps1""" & args, 0, False
