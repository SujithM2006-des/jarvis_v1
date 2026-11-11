# JARVIS switch.
#
# Double-click the "JARVIS - ON / OFF" shortcut on the desktop to flip it.
#
#   ON   starts the background "Hey Jarvis" listener: say the phrase and
#        JARVIS opens. It stays ON across restarts: at every sign-in the
#        listener starts by itself (a hidden entry in the Startup folder),
#        ready for "Hey Jarvis" with nothing to click.
#   OFF  stops the listener (microphone released) and shuts JARVIS down, and
#        stays OFF across restarts too, until switched on again.
#
# Only the small listener starts with Windows — JARVIS himself opens when you
# say his name. The ~/.jarvis/disabled marker is what remembers OFF.
#
#   jarvis-switch.ps1            toggle
#   jarvis-switch.ps1 -Install   only (re)create the desktop and Startup shortcuts
#   jarvis-switch.ps1 -Boot      what sign-in runs: start the listener unless OFF

param([switch]$Install, [switch]$Boot)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $env:USERPROFILE '.jarvis'
$flag = Join-Path $dir 'disabled'
$icons = Join-Path $dir 'icons'
New-Item -ItemType Directory -Force -Path $dir, $icons | Out-Null

# --- icons -------------------------------------------------------------------

# A PNG wrapped in a one-image .ico: crisp at every size on Windows 10/11.
function New-Icon([string]$path, [string]$hex, [bool]$on) {
  if (Test-Path $path) { return }
  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $c = [System.Drawing.ColorTranslator]::FromHtml($hex)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 2, 12, 20))), 8, 8, 240, 240)
  foreach ($w in 34, 22, 12) {
    $glow = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(40, $c.R, $c.G, $c.B)), $w
    $g.DrawEllipse($glow, 30, 30, 196, 196)
  }
  $g.DrawEllipse((New-Object System.Drawing.Pen $c, 10), 30, 30, 196, 196)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, $c.R, $c.G, $c.B)), 3), 66, 66, 124, 124)
  if ($on) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $c), 100, 100, 56, 56)
  } else {
    $p = New-Object System.Drawing.Pen $c, 14
    $p.StartCap = 'Round'; $p.EndCap = 'Round'
    $g.DrawLine($p, 104, 104, 152, 152); $g.DrawLine($p, 152, 104, 104, 152)
  }
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)          # ICONDIR
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)  # 256x256
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$png.Length); $bw.Write([uint32]22)
  $bw.Write($png)
  $bw.Close()
}

$iconOn = Join-Path $icons 'jarvis-on.ico'
$iconOff = Join-Path $icons 'jarvis-off.ico'
New-Icon $iconOn '#19d8d2' $true
New-Icon $iconOff '#ff4d4d' $false

# --- the desktop shortcut ------------------------------------------------------

function Set-Shortcut([bool]$on) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  Get-ChildItem $desktop -Filter 'JARVIS - O*.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force
  $name = if ($on) { 'JARVIS - ON.lnk' } else { 'JARVIS - OFF.lnk' }
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop $name))
  $s.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $s.Arguments = '"' + (Join-Path $PSScriptRoot 'jarvis-switch.vbs') + '"'
  $s.WorkingDirectory = $root
  $s.IconLocation = if ($on) { "$iconOn,0" } else { "$iconOff,0" }
  $s.Description = if ($on) { 'JARVIS is ON - double-click to switch off' } else { 'JARVIS is OFF - double-click to switch on' }
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

function Stop-Jarvis {
  # The JARVIS window (its own Chrome profile) and the brain console. Nothing else.
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like '*face-profile*' -and $_.CommandLine -notlike '*--type=*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match 'npm start -- --writes' } |
    ForEach-Object { & taskkill.exe /T /F /PID $_.ProcessId | Out-Null }
}

$pyw = Join-Path $dir 'wake-venv\Scripts\pythonw.exe'
$listenerScript = Join-Path $PSScriptRoot 'wake_listener.py'

function Get-Listener {
  @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*wake_listener.py*' })
}

function Start-Listener {
  if ((Get-Listener).Count) { return }
  Start-Process -FilePath $pyw -ArgumentList "`"$listenerScript`"" -WorkingDirectory $root -WindowStyle Hidden
}

function Stop-Listener {
  Get-Listener | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# --- starting with Windows -------------------------------------------------------

# A hidden entry in the user's Startup folder: at sign-in it runs this script
# with -Boot, which starts the listener unless the switch is OFF.
function Set-StartupEntry {
  $startup = [Environment]::GetFolderPath('Startup')
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'JARVIS wake listener.lnk'))
  $s.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $s.Arguments = '"' + (Join-Path $PSScriptRoot 'jarvis-switch.vbs') + '" -Boot'
  $s.WorkingDirectory = $root
  $s.IconLocation = "$iconOn,0"
  $s.Description = 'Starts the JARVIS "Hey Jarvis" listener at sign-in (unless the switch is OFF)'
  $s.Save()
}

$isOn = (Get-Listener).Count -gt 0
Set-StartupEntry

if ($Boot) {
  # Sign-in: listen for "Hey Jarvis" straight away — unless it was switched OFF.
  if (Test-Path $flag) {
    Set-Shortcut $false
  } else {
    Start-Listener
    Set-Shortcut $true
  }
  return
}

if ($Install) {
  Set-Shortcut $isOn
  return
}

if ($isOn) {
  # The marker as well, in case a listener is ever started some other way.
  Set-Content -Path $flag -Value "switched off $(Get-Date -Format s)" -Encoding utf8
  Stop-Listener
  Stop-Jarvis
  Set-Shortcut $false
  Show-Toast 'JARVIS is OFF' 'Not listening. Double-click the switch to turn him back on.'
} else {
  Remove-Item $flag -Force -ErrorAction SilentlyContinue
  Start-Listener
  Set-Shortcut $true
  Show-Toast 'JARVIS is ON' 'Say "Hey Jarvis" whenever you need him.'
}
