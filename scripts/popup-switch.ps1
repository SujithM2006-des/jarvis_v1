# JARVIS popup switch.
#
# Double-click the "JARVIS Popup - ON / OFF" shortcut on the desktop to flip it.
#
#   ON   popup mode: the small popup is JARVIS's face. It opens at once (and
#        with JARVIS at every sign-in), reopens if it is ever closed, and the
#        main window works minimised in the background.
#   OFF  the popup is closed and stays closed; the main window comes back.
#        JARVIS himself keeps running - the other switch turns him off.
#
# The ~/.jarvis/popup-mode marker is what remembers ON.
#
#   popup-switch.ps1            toggle
#   popup-switch.ps1 -Install   only (re)create the desktop shortcut

param([switch]$Install)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:USERPROFILE '.jarvis'
$mode = Join-Path $dir 'popup-mode'
$jarvisOff = Join-Path $dir 'disabled'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# The JARVIS switch's icons (made by jarvis-switch.ps1).
$iconOn = Join-Path $dir 'icons\jarvis-on.ico'
$iconOff = Join-Path $dir 'icons\jarvis-off.ico'

function Set-Shortcut([bool]$on) {
  # In its own folder on the desktop; any copy left loose on the desktop goes.
  $desktop = [Environment]::GetFolderPath('Desktop')
  $folder = Join-Path $desktop 'Popup Kill Switch'
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  Get-ChildItem $desktop, $folder -Filter 'JARVIS Popup - O*.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force
  $name = if ($on) { 'JARVIS Popup - ON.lnk' } else { 'JARVIS Popup - OFF.lnk' }
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $folder $name))
  $s.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $s.Arguments = '"' + (Join-Path $PSScriptRoot 'popup-switch.vbs') + '"'
  $s.WorkingDirectory = $root
  $icon = if ($on) { $iconOn } else { $iconOff }
  if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
  $s.Description = if ($on) { 'JARVIS popup is ON - double-click to close it' } else { 'JARVIS popup is OFF - double-click to bring it back' }
  $s.Save()
}

function Show-Toast([string]$title, [string]$body) {
  $x = "<toast><visual><binding template=`"ToastGeneric`"><text>$title</text><text>$body</text></binding></visual></toast>"
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($x)
    $id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
  } catch {}
}

function Stop-Popup {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*jarvis-main*popup.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# The main window, back from minimised - without the popup it is his only face.
# Asked as a system "restore" (what a taskbar click sends), not ShowWindow:
# Chrome, started minimised, put a ShowWindow-restored window back down
# within 3 seconds (measured), but keeps one it restored itself.
function Restore-Main {
  Add-Type -Namespace JarvisSwitch -Name Win -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
  # Titled with the assistant's name (setup can rename him); else the default.
  $title = 'J.A.R.V.I.S.'
  try {
    $a = ([IO.File]::ReadAllText((Join-Path $dir 'profile.json')) | ConvertFrom-Json).assistant
    if ($a -and "$a".Trim().ToUpper() -ne 'JARVIS') { $title = "$a".Trim().ToUpper() }
  } catch {}
  $h = [JarvisSwitch.Win]::FindWindow([NullString]::Value, $title)
  if ($h -eq [IntPtr]::Zero) { $h = [JarvisSwitch.Win]::FindWindow([NullString]::Value, 'J.A.R.V.I.S.') }
  if ($h -ne [IntPtr]::Zero) { [void][JarvisSwitch.Win]::PostMessage($h, 0x112, [IntPtr]0xF120, [IntPtr]::Zero) }  # WM_SYSCOMMAND, SC_RESTORE
}

if ($Install) {
  Set-Shortcut (Test-Path $mode)
  return
}

if (Test-Path $mode) {
  # OFF. The marker goes first, so the bridge does not reopen the popup.
  Remove-Item $mode -Force
  Stop-Popup
  Restore-Main
  Set-Shortcut $false
  Show-Toast 'JARVIS popup is OFF' 'JARVIS keeps running in his own window. Double-click the switch to bring the popup back.'
} else {
  # ON.
  Set-Content -Path $mode -Value "on $(Get-Date -Format s)" -Encoding ascii
  Set-Shortcut $true
  if (Test-Path $jarvisOff) {
    Show-Toast 'JARVIS popup is ON' 'It will appear when JARVIS is switched on.'
    return
  }
  try {
    # JARVIS running: the bridge opens it (and keeps it open).
    $token = ([IO.File]::ReadAllText((Join-Path $dir 'bridge-token'))).Trim()
    Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/popup/show' -Headers @{ 'x-jarvis-token' = $token } -TimeoutSec 3 | Out-Null
  } catch {
    # Not running: start him in popup mode.
    Start-Process -FilePath cmd.exe -ArgumentList '/c', "`"$root\start-jarvis.bat`"" -WorkingDirectory $root -WindowStyle Hidden
  }
  Show-Toast 'JARVIS popup is ON' 'The popup is the face of JARVIS now. Double-click the switch to close it.'
}
