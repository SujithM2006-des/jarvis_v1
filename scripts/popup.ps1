# Onscreen JARVIS — a compact, always-on-top panel, like Copilot's.
#
# Shows what he heard, his live status and his answer as he gives it; type a
# request in the box, or hit "Circle to search". The X closes this panel only —
# JARVIS keeps running. Opened by saying "turn on onscreen jarvis" (the bridge
# starts this script), closed by the X or "turn off onscreen jarvis".

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

$bridge = 'http://127.0.0.1:8787'

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="JARVIS onscreen" Width="580" Height="192" WindowStyle="None"
        AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="False" ResizeMode="NoResize" MinWidth="580" MinHeight="192" MaxWidth="580" MaxHeight="192">
  <!-- Resizable from every edge and corner despite having no frame. -->
  <WindowChrome.WindowChrome>
    <WindowChrome ResizeBorderThickness="0" CaptionHeight="0" CornerRadius="16" GlassFrameThickness="0" UseAeroCaptionButtons="False"/>
  </WindowChrome.WindowChrome>
  <Grid>
  <!-- The tucked-away state: a small tab at the top of the screen. Click to open. -->
  <Border x:Name="Notch" Visibility="Collapsed" CornerRadius="0,0,14,14" BorderThickness="1,0,1,1"
          BorderBrush="#5519D8D2" Background="#F0061822" Cursor="Hand" ToolTip="Open JARVIS">
    <StackPanel Orientation="Horizontal" HorizontalAlignment="Center" VerticalAlignment="Center">
      <Ellipse x:Name="NotchDot" Width="7" Height="7" Fill="#19D8D2" Margin="0,0,7,0"/>
      <TextBlock Text="J.A.R.V.I.S." Foreground="#19D8D2" FontFamily="Segoe UI Semibold" FontSize="11"/>
      <TextBlock Text="&#xE70D;" FontFamily="Segoe MDL2 Assets" Foreground="#7FB6BF" FontSize="9" Margin="7,2,0,0"/>
    </StackPanel>
  </Border>
  <Border x:Name="Panel" CornerRadius="16" BorderThickness="1" BorderBrush="#5519D8D2" Padding="16,12,16,14">
    <Border.Background>
      <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
        <GradientStop Color="#F0061822" Offset="0"/>
        <GradientStop Color="#F0020A10" Offset="1"/>
      </LinearGradientBrush>
    </Border.Background>
    <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="0" Color="#19D8D2" Opacity="0.35"/></Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <Grid Grid.Row="0" x:Name="Header" Background="Transparent" Margin="0,0,0,8">
        <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
          <Ellipse x:Name="Dot" Width="9" Height="9" Fill="#19D8D2" Margin="0,0,9,0">
            <Ellipse.Effect><DropShadowEffect BlurRadius="10" ShadowDepth="0" Color="#19D8D2" Opacity="0.9"/></Ellipse.Effect>
          </Ellipse>
          <TextBlock Text="J.A.R.V.I.S." Foreground="#19D8D2" FontFamily="Segoe UI Semibold" FontSize="14"/>
          <TextBlock x:Name="Status" Text="  ·  connecting" Foreground="#7FB6BF" FontFamily="Segoe UI" FontSize="11" VerticalAlignment="Center" Margin="4,1,0,0"/>
        </StackPanel>
        <Button x:Name="Close" Content="✕" HorizontalAlignment="Right" Width="26" Height="26" FontSize="13"
                Foreground="#9FD8DC" Background="Transparent" BorderThickness="0" Cursor="Hand" ToolTip="Close the popup (JARVIS keeps running)"/>
      </Grid>
      <ScrollViewer Grid.Row="1" x:Name="Scroll" VerticalScrollBarVisibility="Auto">
        <StackPanel>
          <TextBlock x:Name="Heard" TextWrapping="Wrap" Foreground="#7FB6BF" FontFamily="Segoe UI" FontSize="12" Margin="0,0,0,6"/>
          <TextBlock x:Name="Said" TextWrapping="Wrap" Foreground="#E6FBFF" FontFamily="Segoe UI" FontSize="14"
                     Text="Say &quot;Hey Jarvis&quot;, type below, or circle something on screen."/>
        </StackPanel>
      </ScrollViewer>
      <Grid Grid.Row="2" Margin="0,10,0,0">
        <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <Button x:Name="Circle" Grid.Column="0" Content="◯" Width="34" Height="32" FontSize="15" Margin="0,0,8,0"
                Foreground="#19D8D2" Background="#2219D8D2" BorderBrush="#5519D8D2" Cursor="Hand" ToolTip="Circle to search"/>
        <Button x:Name="Mic" Grid.Column="1" Content="&#xE720;" FontFamily="Segoe MDL2 Assets" Width="34" Height="32" FontSize="15" Margin="0,0,8,0"
                Foreground="#19D8D2" Background="#2219D8D2" BorderBrush="#5519D8D2" Cursor="Hand"
                ToolTip="Talk to JARVIS (tap again to put him on standby)"/>
        <TextBox x:Name="Input" Grid.Column="2" Height="32" Padding="8,6" FontFamily="Segoe UI" FontSize="13"
                 Foreground="#E6FBFF" CaretBrush="#19D8D2" Background="#14FFFFFF" BorderBrush="#3319D8D2"/>
        <Button x:Name="Send" Grid.Column="3" Content="➤" Width="34" Height="32" FontSize="14" Margin="8,0,0,0"
                Foreground="#02121A" Background="#19D8D2" BorderThickness="0" Cursor="Hand" ToolTip="Send"/>
      </Grid>
    </Grid>
  </Border>
  </Grid>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}
foreach ($n in 'Header', 'Dot', 'Status', 'Close', 'Scroll', 'Heard', 'Said', 'Circle', 'Mic', 'Input', 'Send', 'Panel', 'Notch', 'NotchDot') { $el[$n] = $win.FindName($n) }
$brush = { param($hex) (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex) }
$micIdle = & $brush '#2219D8D2'
$micLive = & $brush '#19D8D2'
$micIdleFg = & $brush '#19D8D2'
$micLiveFg = & $brush '#02121A'

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
  if ($script:collapsed) { return }
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
$el.Close.Add_Click({ $win.Close() })

function Post([string]$path, $body) {
  try {
    $json = if ($body) { $body | ConvertTo-Json -Compress } else { '{}' }
    Invoke-RestMethod -Method Post -Uri "$bridge$path" -Body $json -ContentType 'application/json' -TimeoutSec 3 | Out-Null
    return $true
  } catch { return $false }
}

function Send-Input {
  $text = $el.Input.Text.Trim()
  if (-not $text) { return }
  if (Post '/popup/ask' @{ text = $text }) { $el.Input.Text = '' }
  else { $el.Status.Text = '  ·  JARVIS is not running' }
}
$el.Send.Add_Click({ Send-Input })
$el.Input.Add_KeyDown({ if ($_.Key -eq 'Return') { Send-Input } })
$el.Circle.Add_Click({ Post '/circle' $null | Out-Null })
# Mic: listen now (like "Hey Jarvis"); tapped while listening, standby.
$el.Mic.Add_Click({
  if (-not (Post '/popup/mic' $null)) { $el.Status.Text = '  ·  JARVIS is not running' }
})

$labels = @{ dormant = 'standby'; waking = 'listening'; listening = 'listening'; thinking = 'thinking';
             tooling = 'working'; speaking = 'speaking'; boot = 'starting'; offline = 'offline' }
$last = ''
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  try {
    $s = Invoke-RestMethod -Uri "$bridge/popup/state" -TimeoutSec 1
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
      $busyHere = (Test-MouseOver) -or $el.Input.IsKeyboardFocused -or $el.Input.Text
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
    $key = "$($s.heard)|$($s.said)"
    if ($key -ne $last) {
      $last = $key
      $el.Heard.Text = if ($s.heard) { "You: $($s.heard)" } else { '' }
      if ($s.said) { $el.Said.Text = $s.said }
      $el.Scroll.ScrollToEnd()
    }
  } catch {
    $el.Status.Text = '  ·  JARVIS is not running'
    $el.Dot.Opacity = 0.25
  }
})
$timer.Start()
# Clear any click recorded before the panel existed, then start watching.
[void][JarvisPopup.Keys]::GetAsyncKeyState(0x01); [void][JarvisPopup.Keys]::GetAsyncKeyState(0x02)
$clickTimer.Start()

# The popup takes over from the main window: tuck that away so it's out of
# sight while still running (and listening) in the background.
$main = [JarvisPopup.Keys]::FindWindow([NullString]::Value, 'J.A.R.V.I.S.')
if ($main -ne [IntPtr]::Zero) { [void][JarvisPopup.Keys]::ShowWindow($main, 6) }

[void]$win.ShowDialog()
