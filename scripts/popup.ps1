# Onscreen JARVIS — a compact, always-on-top panel, like Copilot's.
#
# Shows what he heard, his live status and his answer as he gives it; type a
# request in the box, or hit "Circle to search". The X closes this panel only —
# JARVIS keeps running. Opened by saying "turn on onscreen jarvis" (the bridge
# starts this script), closed by the X or "turn off onscreen jarvis".

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$bridge = 'http://127.0.0.1:8787'
# The bridge's local key (~/.jarvis/bridge-token), made fresh each time JARVIS
# starts: read per request, so the popup keeps working across his restarts.
$tokenFile = Join-Path $env:USERPROFILE '.jarvis\bridge-token'
function Auth { try { @{ 'x-jarvis-token' = ([IO.File]::ReadAllText($tokenFile)).Trim() } } catch { @{} } }

# One popup at a time. Exit code 3 tells the bridge one is already open, so it
# does not try to reopen this one.
$script:single = New-Object System.Threading.Mutex($false, 'Local\JarvisPopup')
try { $mine = $script:single.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $mine = $true }
if (-not $mine) { exit 3 }

# Popup mode (~/.jarvis/popup-mode): this panel is JARVIS's face. The X tucks
# it away instead of closing it, and if JARVIS is not running, typing a request
# or tapping the mic starts him (minimised) and hands the request over.
function PopupMode { Test-Path (Join-Path $env:USERPROFILE '.jarvis\popup-mode') }
$jarvisRoot = Split-Path -Parent $PSScriptRoot
$script:lastStart = [datetime]::MinValue
function Start-Jarvis([string]$text) {
  if (((Get-Date) - $script:lastStart).TotalSeconds -lt 45) { return }
  $script:lastStart = Get-Date
  if ($text) {
    $json = @{ text = $text; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
    # No BOM: the bridge parses this as plain JSON.
    try { [IO.File]::WriteAllText((Join-Path $env:USERPROFILE '.jarvis\pending-command.json'), $json) } catch {}
  }
  Start-Process -FilePath cmd.exe -ArgumentList '/c', "`"$jarvisRoot\start-jarvis.bat`"", 'wake' -WindowStyle Hidden
}
function Starting { ((Get-Date) - $script:lastStart).TotalSeconds -lt 60 }

# --- colour ---------------------------------------------------------------------
# The same colour as the interface: the theme chosen in setup
# (~/.jarvis/profile.json) turns every colour here by the same hue as the
# interface's CSS hue-rotate, with the same matrix, so the two match exactly.
# The mute red stays red: it means "muted" whatever the theme.
$profileFile = Join-Path $env:USERPROFILE '.jarvis\profile.json'
$themeHues = @{ blue = 0; teal = -25; green = -60; purple = 70; crimson = 150; amber = 200
                orange = 180; yellow = 220; lime = -110; indigo = 30; magenta = 115 }
function Get-Theme {
  try { $t = ([IO.File]::ReadAllText($profileFile) | ConvertFrom-Json).theme } catch { $t = $null }
  if ($t -and $themeHues.ContainsKey($t)) { $t } else { 'blue' }
}
$script:theme = Get-Theme
$script:hue = $themeHues[$script:theme]
function Turn-Colour([string]$hex) {
  if ($script:hue -eq 0 -or $hex -ieq '#E0465A') { return $hex }
  $h = $hex.TrimStart('#')
  $a = ''
  if ($h.Length -eq 8) { $a = $h.Substring(0, 2); $h = $h.Substring(2) }
  $r = [Convert]::ToInt32($h.Substring(0, 2), 16); $g = [Convert]::ToInt32($h.Substring(2, 2), 16); $b = [Convert]::ToInt32($h.Substring(4, 2), 16)
  $rad = $script:hue * [math]::PI / 180; $c = [math]::Cos($rad); $s = [math]::Sin($rad)
  $nr = $r * (0.213 + $c * 0.787 - $s * 0.213) + $g * (0.715 - $c * 0.715 - $s * 0.715) + $b * (0.072 - $c * 0.072 + $s * 0.928)
  $ng = $r * (0.213 - $c * 0.213 + $s * 0.143) + $g * (0.715 + $c * 0.285 + $s * 0.140) + $b * (0.072 - $c * 0.072 - $s * 0.283)
  $nb = $r * (0.213 - $c * 0.213 - $s * 0.787) + $g * (0.715 - $c * 0.715 + $s * 0.715) + $b * (0.072 + $c * 0.928 + $s * 0.072)
  $clamp = { param($v) [int][math]::Max(0, [math]::Min(255, [math]::Round($v))) }
  '#{0}{1:X2}{2:X2}{3:X2}' -f $a, (& $clamp $nr), (& $clamp $ng), (& $clamp $nb)
}

$xamlText = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="JARVIS onscreen" Width="580" Height="192" WindowStyle="None"
        AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="False" AllowDrop="True" ResizeMode="NoResize" MinWidth="580" MinHeight="192" MaxWidth="580" MaxHeight="192">
  <!-- Resizable from every edge and corner despite having no frame. -->
  <WindowChrome.WindowChrome>
    <WindowChrome ResizeBorderThickness="0" CaptionHeight="0" CornerRadius="16" GlassFrameThickness="0" UseAeroCaptionButtons="False"/>
  </WindowChrome.WindowChrome>
  <Grid>
  <!-- The tucked-away state: a small tab at the top of the screen. Click to open. -->
  <Border x:Name="Notch" Visibility="Collapsed" CornerRadius="0,0,14,14" BorderThickness="1,0,1,1"
          BorderBrush="#553FB6FF" Background="#F00A1F45" Cursor="Hand" ToolTip="Open JARVIS">
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Center" VerticalAlignment="Center">
      <Ellipse x:Name="NotchDot" Width="7" Height="7" Fill="#3FB6FF" Margin="0,0,7,0"/>
      <TextBlock Text="J.A.R.V.I.S." Foreground="#3FB6FF" FontFamily="Segoe UI Semibold" FontSize="11"/>
      <TextBlock Text="&#xE70D;" FontFamily="Segoe MDL2 Assets" Foreground="#9CC4EE" FontSize="9" Margin="7,2,0,0"/>
    </StackPanel>
  </Border>
  <Border x:Name="Panel" CornerRadius="16" BorderThickness="1" BorderBrush="#553FB6FF" Padding="16,12,16,14">
    <Border.Background>
      <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
        <GradientStop Color="#F00A1F45" Offset="0"/>
        <GradientStop Color="#F003091C" Offset="1"/>
      </LinearGradientBrush>
    </Border.Background>
    <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="0" Color="#3FB6FF" Opacity="0.35"/></Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <Grid Grid.Row="0" x:Name="Header" Background="Transparent" Margin="0,0,0,8">
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
          <Ellipse x:Name="Dot" Width="9" Height="9" Fill="#3FB6FF" Margin="0,0,9,0">
            <Ellipse.Effect><DropShadowEffect BlurRadius="10" ShadowDepth="0" Color="#3FB6FF" Opacity="0.9"/></Ellipse.Effect>
          </Ellipse>
          <TextBlock Text="J.A.R.V.I.S." Foreground="#3FB6FF" FontFamily="Segoe UI Semibold" FontSize="14"/>
          <TextBlock x:Name="Status" Text="  ·  connecting" Foreground="#9CC4EE" FontFamily="Segoe UI" FontSize="11" VerticalAlignment="Center" Margin="4,1,0,0"/>
        </StackPanel>
        <Button x:Name="Close" Content="✕" HorizontalAlignment="Right" Width="26" Height="26" FontSize="13"
                Foreground="#A8D4FF" Background="Transparent" BorderThickness="0" Cursor="Hand" ToolTip="Close the popup (JARVIS keeps running)"/>
      </Grid>
      <ScrollViewer Grid.Row="1" x:Name="Scroll" VerticalScrollBarVisibility="Auto">
        <StackPanel>
          <TextBlock x:Name="Heard" TextWrapping="Wrap" Foreground="#9CC4EE" FontFamily="Segoe UI" FontSize="12" Margin="0,0,0,6"/>
          <TextBlock x:Name="Said" TextWrapping="Wrap" Foreground="#E9F3FF" FontFamily="Segoe UI" FontSize="14"
                     Text="Say &quot;Hey Jarvis&quot;, type below, attach or drop a file, or circle something on screen."/>
        </StackPanel>
      </ScrollViewer>
      <!-- Files waiting to be sent: names, and a cross to drop them. -->
      <Grid Grid.Row="2" x:Name="AttachRow" Visibility="Collapsed" Margin="0,6,0,0">
        <TextBlock x:Name="AttachList" Foreground="#A8D4FF" FontFamily="Segoe UI" FontSize="11.5"
                   TextTrimming="CharacterEllipsis" VerticalAlignment="Center" Margin="0,0,26,0"/>
        <Button x:Name="AttachClear" Content="✕" HorizontalAlignment="Right" Width="20" Height="20" FontSize="10"
                Foreground="#A8D4FF" Background="Transparent" BorderThickness="0" Cursor="Hand" ToolTip="Remove the attachments"/>
      </Grid>
      <Grid Grid.Row="3" Margin="0,8,0,0">
        <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <Button x:Name="Circle" Grid.Column="0" Content="◯" Width="34" Height="32" FontSize="15" Margin="0,0,8,0"
                Foreground="#3FB6FF" Background="#223FB6FF" BorderBrush="#553FB6FF" Cursor="Hand" ToolTip="Circle to search"/>
        <Button x:Name="Mic" Grid.Column="1" Content="&#xE720;" FontFamily="Segoe MDL2 Assets" Width="34" Height="32" FontSize="15" Margin="0,0,8,0"
                Foreground="#3FB6FF" Background="#223FB6FF" BorderBrush="#553FB6FF" Cursor="Hand"
                ToolTip="Talk to JARVIS (tap again to put him on standby)"/>
        <!-- Mute: a microphone with a slash; red while muted. -->
        <Button x:Name="Mute" Grid.Column="2" Width="34" Height="32" Margin="0,0,8,0"
                Background="#223FB6FF" BorderBrush="#553FB6FF" Cursor="Hand" ToolTip="Mute the microphone">
          <Grid>
            <TextBlock x:Name="MuteGlyph" Text="&#xE720;" FontFamily="Segoe MDL2 Assets" FontSize="15" Foreground="#3FB6FF"
                       HorizontalAlignment="Center" VerticalAlignment="Center"/>
            <Line x:Name="MuteSlash" X1="0" Y1="0" X2="16" Y2="16" Stroke="#3FB6FF" StrokeThickness="2"
                  HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Grid>
        </Button>
        <Button x:Name="Attach" Grid.Column="3" Content="&#xE723;" FontFamily="Segoe MDL2 Assets" Width="34" Height="32" FontSize="15" Margin="0,0,8,0"
                Foreground="#3FB6FF" Background="#223FB6FF" BorderBrush="#553FB6FF" Cursor="Hand"
                ToolTip="Attach documents or images (or drop them here, or paste with Ctrl+V)"/>
        <TextBox x:Name="Input" Grid.Column="4" Height="32" Padding="8,6" FontFamily="Segoe UI" FontSize="13"
                 Foreground="#E9F3FF" CaretBrush="#3FB6FF" Background="#14FFFFFF" BorderBrush="#333FB6FF"/>
        <Button x:Name="Send" Grid.Column="5" Content="➤" Width="34" Height="32" FontSize="14" Margin="8,0,0,0"
                Foreground="#02132B" Background="#3FB6FF" BorderThickness="0" Cursor="Hand" ToolTip="Send"/>
      </Grid>
    </Grid>
  </Border>
  </Grid>
</Window>
'@
[xml]$xaml = [regex]::Replace($xamlText, '#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})\b', { param($m) Turn-Colour $m.Value })

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}
foreach ($n in 'Header', 'Dot', 'Status', 'Close', 'Scroll', 'Heard', 'Said', 'Circle', 'Mic', 'Mute', 'MuteGlyph', 'MuteSlash', 'Attach', 'AttachRow', 'AttachList', 'AttachClear', 'Input', 'Send', 'Panel', 'Notch', 'NotchDot') { $el[$n] = $win.FindName($n) }
$brush = { param($hex) (New-Object System.Windows.Media.BrushConverter).ConvertFromString((Turn-Colour $hex)) }
$micIdle = & $brush '#223FB6FF'
$micLive = & $brush '#3FB6FF'
$micIdleFg = & $brush '#3FB6FF'
$micLiveFg = & $brush '#02132B'

# Where it was last left, at the size it was last given; otherwise bottom-right,
# just above the taskbar. Kept on screen in case the display has changed.
$area = [System.Windows.SystemParameters]::WorkArea
$saved = Join-Path $env:USERPROFILE '.jarvis\popup.json'
$win.Left = $area.Right - $win.Width - 18
$win.Top = $area.Bottom - $win.Height - 18
try {
  $p = Get-Content $saved -Raw | ConvertFrom-Json
  $win.Left = [math]::Max($area.Left, [math]::Min([double]$p.left, $area.Right - $win.Width))
  $win.Top = [math]::Max($area.Top, [math]::Min([double]$p.top, $area.Bottom - $win.Height))
} catch {}

# --- tucking away -------------------------------------------------------------
# Not in use for IDLE_SECONDS (JARVIS on standby, mouse elsewhere, nothing being
# typed) and the panel slides up into a small notch at the top of the screen,
# like a closed drawer. Clicking the notch — or JARVIS waking up — opens it
# again exactly where it was, at the same size.
$IDLE_SECONDS = 10
$NOTCH_W = 170
$NOTCH_H = 26
$script:collapsed = $false
# Measured on the clock, not by counting timer ticks: each tick also waits on
# the bridge, so ticks arrive slower than their interval says.
$script:idleSince = Get-Date
$script:exp = $null
$script:wasActive = $false

function Collapse-Panel {
  if ($script:collapsed) { return }
  $script:exp = @{ left = $win.Left; top = $win.Top; width = $win.Width; height = $win.Height }
  $script:collapsed = $true
  $el.Panel.Visibility = 'Collapsed'
  $el.Notch.Visibility = 'Visible'
  $win.ResizeMode = 'NoResize'
  $win.MinWidth = 0; $win.MinHeight = 0; $win.MaxWidth = [double]::PositiveInfinity; $win.MaxHeight = [double]::PositiveInfinity
  $win.Width = $NOTCH_W; $win.Height = $NOTCH_H
  $win.Left = $area.Left + ($area.Width - $NOTCH_W) / 2
  $win.Top = $area.Top
}

function Expand-Panel {
  if (-not $script:collapsed) { return }
  $script:collapsed = $false
  $script:idleSince = Get-Date
  $el.Notch.Visibility = 'Collapsed'
  $el.Panel.Visibility = 'Visible'
  $win.MinWidth = 580; $win.MinHeight = 192; $win.MaxWidth = 580; $win.MaxHeight = 192
  $win.Width = 580; $win.Height = 192
  $win.Left = $script:exp.left; $win.Top = $script:exp.top
  $win.ResizeMode = 'NoResize'
  # The click that opened it (on the notch) must not count as a click away.
  [void][JarvisPopup.Keys]::GetAsyncKeyState(0x01); [void][JarvisPopup.Keys]::GetAsyncKeyState(0x02)
}

$el.Notch.Add_MouseLeftButtonUp({ Expand-Panel })

# Where the pointer really is, against the panel's rectangle. WPF's own
# IsMouseOver stays true on this frameless, transparent window long after the
# pointer has left (measured: true throughout with the mouse elsewhere), which
# kept the panel from ever tucking away.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace JarvisPopup -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'

# Clicking anywhere else — the desktop, another window — tucks it away at once.
# Polled rather than evented: when the panel opened by itself (JARVIS waking)
# it never had focus, so there is no "lost focus" event to wait for. The low
# bit of GetAsyncKeyState also catches a click that started and ended between
# two polls.
$clickTimer = New-Object System.Windows.Threading.DispatcherTimer
$clickTimer.Interval = [TimeSpan]::FromMilliseconds(100)
$clickTimer.Add_Tick({
  $l = [JarvisPopup.Keys]::GetAsyncKeyState(0x01)
  $r = [JarvisPopup.Keys]::GetAsyncKeyState(0x02)
  if ($script:collapsed -or $script:modal) { return }
  if ((($l -bor $r) -band 0x8001) -and -not (Test-MouseOver)) { Collapse-Panel }
})

function Test-MouseOver {
  $src = [System.Windows.PresentationSource]::FromVisual($win)
  if (-not $src) { return $false }
  $c = [System.Windows.Forms.Cursor]::Position
  $pt = $src.CompositionTarget.TransformFromDevice.Transform((New-Object System.Windows.Point $c.X, $c.Y))
  return ($pt.X -ge $win.Left -and $pt.X -le $win.Left + $win.Width -and
          $pt.Y -ge $win.Top -and $pt.Y -le $win.Top + $win.Height)
}

$win.Add_Closing({
  try {
    # The open size and place, even if it is tucked away when closed.
    $g = if ($script:collapsed -and $script:exp) { $script:exp } else {
      @{ left = $win.Left; top = $win.Top; width = $win.Width; height = $win.Height } }
    $g | ConvertTo-Json -Compress | Set-Content -Path $saved -Encoding ascii
  } catch {}
})

$el.Header.Add_MouseLeftButtonDown({ $win.DragMove() })
$el.Close.Add_Click({ if (PopupMode) { Collapse-Panel } else { $win.Close() } })
if (PopupMode) { $el.Close.ToolTip = 'Tuck away (click the notch at the top to open it again)' }

function Post([string]$path, $body, [int]$timeout = 3) {
  try {
    $json = if ($body) { $body | ConvertTo-Json -Compress } else { '{}' }
    # UTF-8 bytes: a file or folder name with non-ASCII characters must survive.
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Method Post -Uri "$bridge$path" -Headers (Auth) -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec $timeout | Out-Null
    return $true
  } catch { return $false }
}

# --- attachments --------------------------------------------------------------
# Documents and images for him to work with: the paperclip, drag and drop onto
# the panel (or the notch), or Ctrl+V with a screenshot or copied files.
$script:files = New-Object System.Collections.ArrayList
$script:modal = $false

function Update-Attach {
  if ($script:files.Count) {
    $names = ($script:files | ForEach-Object { [IO.Path]::GetFileName($_) }) -join '  ·  '
    $el.AttachList.Text = [char]::ConvertFromUtf32(0x1F4CE) + " $names"
    $el.AttachList.ToolTip = ($script:files -join "`n")
    $el.AttachRow.Visibility = 'Visible'
  } else {
    $el.AttachRow.Visibility = 'Collapsed'
  }
}

function Add-Files($paths) {
  foreach ($f in @($paths)) {
    $f = "$f"
    if ($f -and (Test-Path -LiteralPath $f -PathType Leaf) -and -not $script:files.Contains($f) -and $script:files.Count -lt 10) {
      [void]$script:files.Add($f)
    }
  }
  Update-Attach
}

$el.AttachClear.Add_Click({ $script:files.Clear(); Update-Attach })

$el.Attach.Add_Click({
  $script:modal = $true
  try {
    $dlg = New-Object Microsoft.Win32.OpenFileDialog
    $dlg.Title = 'Give JARVIS documents or images'
    $dlg.Multiselect = $true
    $dlg.Filter = 'Documents, images and voice clips|*.mp3;*.wav;*.m4a;*.ogg;*.flac;*.webm;*.pdf;*.docx;*.pptx;*.xlsx;*.txt;*.md;*.csv;*.json;*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.py;*.java;*.c;*.cpp;*.js;*.ts;*.html;*.css|All files|*.*'
    if ($dlg.ShowDialog($win)) { Add-Files $dlg.FileNames }
  } finally {
    $script:modal = $false
    # The clicks made inside the dialog are not clicks away from the panel.
    [void][JarvisPopup.Keys]::GetAsyncKeyState(0x01); [void][JarvisPopup.Keys]::GetAsyncKeyState(0x02)
    $script:idleSince = Get-Date
  }
  $el.Input.Focus() | Out-Null
})

# Drag and drop. Preview events, so the text box doesn't swallow the drop.
$win.Add_PreviewDragOver({
  $_.Effects = if ($_.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) { 'Copy' } else { 'None' }
  $_.Handled = $true
})
$win.Add_PreviewDrop({
  if ($_.Data.GetDataPresent([Windows.DataFormats]::FileDrop)) {
    Add-Files ($_.Data.GetData([Windows.DataFormats]::FileDrop))
    $_.Handled = $true
    Expand-Panel
    $script:idleSince = Get-Date
    $win.Activate() | Out-Null
    $el.Input.Focus() | Out-Null
  }
})

# Ctrl+V: copied files, or a screenshot (Win+Shift+S) saved as a PNG.
$el.Input.Add_PreviewKeyDown({
  if ($_.Key -eq 'V' -and ([Windows.Input.Keyboard]::Modifiers -band [Windows.Input.ModifierKeys]::Control)) {
    if ([Windows.Clipboard]::ContainsFileDropList()) {
      Add-Files ([Windows.Clipboard]::GetFileDropList())
      $_.Handled = $true
    } elseif ([Windows.Clipboard]::ContainsImage()) {
      $png = Join-Path $env:TEMP ("jarvis-paste-{0:yyyyMMdd-HHmmss}.png" -f (Get-Date))
      $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
      $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create([Windows.Clipboard]::GetImage()))
      $fs = [IO.File]::Create($png)
      try { $enc.Save($fs) } finally { $fs.Close() }
      Add-Files $png
      $_.Handled = $true
    }
  }
})

# --- request history ----------------------------------------------------------
# Up and Down in the box step through earlier requests, like a chat box in an
# editor: Up for older, Down for newer, and past the newest back to whatever
# was being typed. Drawn from the conversation journal (~/.jarvis/history.jsonl),
# so it includes spoken requests and survives restarts.
$historyFile = Join-Path $env:USERPROFILE '.jarvis\history.jsonl'
$script:hist = @()
$script:histIdx = -1
$script:draft = ''
$script:lastSent = ''

function Load-History {
  $list = New-Object System.Collections.ArrayList
  try {
    foreach ($line in (Get-Content -LiteralPath $historyFile -Tail 400 -Encoding UTF8 -ErrorAction Stop)) {
      try { $u = ($line | ConvertFrom-Json).user } catch { continue }
      if (-not $u -or $u -like '(Circle to Search*') { continue }
      # Attached files were listed as " 📎 name, name" — keep the words only.
      $u = ($u -replace '\s*\uD83D\uDCCE.*$', '').Trim()
      if ($u -and ($list.Count -eq 0 -or $list[$list.Count - 1] -ne $u)) { [void]$list.Add($u) }
    }
  } catch {}
  # Something just sent may not be in the journal yet (it is written when the
  # answer finishes).
  if ($script:lastSent -and ($list.Count -eq 0 -or $list[$list.Count - 1] -ne $script:lastSent)) {
    [void]$list.Add($script:lastSent)
  }
  $script:hist = @($list)
}

function Show-History([string]$text) {
  $el.Input.Text = $text
  $el.Input.CaretIndex = $text.Length
}

$el.Input.Add_PreviewKeyDown({
  if ($_.Key -eq 'Up') {
    if ($script:histIdx -lt 0) {
      Load-History
      if (-not $script:hist.Count) { return }
      $script:draft = $el.Input.Text
      $script:histIdx = $script:hist.Count - 1
    } elseif ($script:histIdx -gt 0) {
      $script:histIdx--
    }
    Show-History $script:hist[$script:histIdx]
    $_.Handled = $true
  } elseif ($_.Key -eq 'Down') {
    if ($script:histIdx -lt 0) { return }
    if ($script:histIdx -lt $script:hist.Count - 1) {
      $script:histIdx++
      Show-History $script:hist[$script:histIdx]
    } else {
      $script:histIdx = -1
      Show-History $script:draft
    }
    $_.Handled = $true
  } elseif ($_.Key -eq 'Escape' -and $script:histIdx -ge 0) {
    $script:histIdx = -1
    Show-History $script:draft
    $_.Handled = $true
  }
})

function Send-Input {
  $text = $el.Input.Text.Trim()
  if (-not $text -and -not $script:files.Count) { return }
  $body = @{ text = $text }
  if ($script:files.Count) { $body.files = @($script:files.ToArray()) }
  # Longer wait with files: the bridge copies them and extracts Office text first.
  $timeout = if ($script:files.Count) { 90 } else { 3 }
  if (Post '/popup/ask' $body $timeout) {
    if ($text) { $script:lastSent = $text }
    $script:histIdx = -1
    $script:draft = ''
    $el.Input.Text = ''
    $script:files.Clear(); Update-Attach
  } elseif ((PopupMode) -and $text) {
    # Not running: start him and hand the request over when he is up.
    Start-Jarvis $text
    if ($text) { $script:lastSent = $text }
    $el.Input.Text = ''
    $el.Status.Text = '  ·  starting JARVIS…'
  } else { $el.Status.Text = '  ·  JARVIS is not running' }
}
$el.Send.Add_Click({ Send-Input })
$el.Input.Add_KeyDown({ if ($_.Key -eq 'Return') { Send-Input } })
$el.Circle.Add_Click({ Post '/circle' $null | Out-Null })
# Mic: listen now (like "Hey Jarvis"); tapped while listening, standby.
# Mute: the microphone off for JARVIS (this window and the background "Hey
# Jarvis" listener) until tapped again. The mic button also unmutes.
$muteOn = & $brush '#E0465A'
$muteFg = & $brush '#02132B'
$el.Mute.Add_Click({
  if (-not (Post '/popup/mute' $null)) { $el.Status.Text = '  ·  JARVIS is not running' }
})
$el.Mic.Add_Click({
  if (Post '/popup/mic' $null) { return }
  if (PopupMode) { Start-Jarvis ''; $el.Status.Text = '  ·  starting JARVIS…' }
  else { $el.Status.Text = '  ·  JARVIS is not running' }
})

$labels = @{ dormant = 'standby'; waking = 'listening'; listening = 'listening'; thinking = 'thinking';
             tooling = 'working'; speaking = 'speaking'; boot = 'starting'; offline = 'offline' }
$last = ''
$timer = New-Object System.Windows.Threading.DispatcherTimer
# 250 ms: still reads as live, at well under half the background work of 150.
$timer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:themeTick = 0
$aliveFile = Join-Path $env:USERPROFILE '.jarvis\popup-alive'
$timer.Add_Tick({
  # A new colour chosen in the interface: every couple of seconds, look; if it
  # changed, open a fresh popup in that colour, in the same place, and close
  # this one. (The colours are baked in when the panel is built.)
  $script:themeTick = ($script:themeTick + 1) % 8
  # Alive: the bridge reopens the popup when this goes stale (popup mode).
  if ($script:themeTick -eq 0) { try { [IO.File]::WriteAllText($aliveFile, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) } catch {} }
  if ($script:themeTick -eq 0 -and (Get-Theme) -ne $script:theme) {
    $timer.Stop()
    try {
      $g = if ($script:collapsed -and $script:exp) { $script:exp } else { @{ left = $win.Left; top = $win.Top; width = $win.Width; height = $win.Height } }
      $g | ConvertTo-Json -Compress | Set-Content -Path $saved -Encoding ascii
    } catch {}
    try { $script:single.ReleaseMutex() } catch {}
    Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$PSCommandPath`"" -WindowStyle Hidden
    $win.Close()
    return
  }
  try {
    $s = Invoke-RestMethod -Uri "$bridge/popup/state" -Headers (Auth) -TimeoutSec 1
    $phase = if ($labels.ContainsKey($s.phase)) { $labels[$s.phase] } else { $s.phase }
    if ($s.tool -and $s.phase -eq 'tooling') { $phase = "working · $($s.tool)" }
    $el.Status.Text = "  ·  $phase"
    $el.Dot.Opacity = if ($s.phase -in 'listening', 'waking', 'speaking') { 1 } else { 0.45 }
    # Tuck away when unused; open again the moment he is active.
    $active = $s.phase -in 'waking', 'listening', 'thinking', 'tooling', 'speaking'
    # Open again only when he *becomes* active — a new "Hey Jarvis" or mic tap —
    # not merely because he still is: clicking away mid-answer must stick.
    $rising = $active -and -not $script:wasActive
    $script:wasActive = $active
    if ($script:collapsed) {
      $el.NotchDot.Opacity = if ($active) { 1 } else { 0.5 }
      if ($rising) { Expand-Panel }
    } else {
      $busyHere = (Test-MouseOver) -or $el.Input.IsKeyboardFocused -or $el.Input.Text -or $script:files.Count -or $script:modal
      if ($env:JARVIS_POPUP_DEBUG -eq '1') {
        Add-Content -Path (Join-Path $env:TEMP 'jarvis-popup-debug.log') -Value (
          "{0:HH:mm:ss} phase={1} active={2} mouseOver={3} kbFocus={4} text='{5}' idle={6:N1}s cursor={7} win=({8:N0},{9:N0} {10:N0}x{11:N0})" -f
          (Get-Date), $s.phase, $active, (Test-MouseOver), $el.Input.IsKeyboardFocused, $el.Input.Text,
          ((Get-Date) - $script:idleSince).TotalSeconds, [System.Windows.Forms.Cursor]::Position,
          $win.Left, $win.Top, $win.Width, $win.Height)
      }
      if ($active -or $busyHere) { $script:idleSince = Get-Date }
      elseif (((Get-Date) - $script:idleSince).TotalSeconds -ge $IDLE_SECONDS) { Collapse-Panel }
    }
    # The mic button lights up while he is listening.
    $live = $s.phase -in 'listening', 'waking'
    $el.Mic.Background = if ($live) { $micLive } else { $micIdle }
    $el.Mic.Foreground = if ($live) { $micLiveFg } else { $micIdleFg }
    # The mute button turns red while muted, and the status says so.
    $isMuted = [bool]$s.muted
    $el.Mute.Background = if ($isMuted) { $muteOn } else { $micIdle }
    $fg = if ($isMuted) { $muteFg } else { $micIdleFg }
    $el.MuteGlyph.Foreground = $fg; $el.MuteSlash.Stroke = $fg
    $el.Mute.ToolTip = if ($isMuted) { 'Unmute the microphone' } else { 'Mute the microphone' }
    if ($isMuted) { $el.Status.Text = '  ·  muted' }
    $key = "$($s.heard)|$($s.said)"
    if ($key -ne $last) {
      $last = $key
      $el.Heard.Text = if ($s.heard) { "You: $($s.heard)" } else { '' }
      if ($s.said) { $el.Said.Text = $s.said }
      $el.Scroll.ScrollToEnd()
    }
  } catch {
    $el.Status.Text = if (Starting) { '  ·  starting JARVIS…' } else { '  ·  JARVIS is not running' }
    $el.Dot.Opacity = 0.25
  }
})
$timer.Start()
# Clear any click recorded before the panel existed, then start watching.
[void][JarvisPopup.Keys]::GetAsyncKeyState(0x01); [void][JarvisPopup.Keys]::GetAsyncKeyState(0x02)
$clickTimer.Start()

# The popup takes over from the main window: tuck that away so it's out of
# sight while still running (and listening) in the background.
# Not before the first-run setup is done: that screen is in the main window.
$main = [JarvisPopup.Keys]::FindWindow([NullString]::Value, 'J.A.R.V.I.S.')
$setUp = Test-Path (Join-Path $env:USERPROFILE '.jarvis\profile.json')
if ($setUp -and $main -ne [IntPtr]::Zero) { [void][JarvisPopup.Keys]::ShowWindow($main, 6) }

[void]$win.ShowDialog()
