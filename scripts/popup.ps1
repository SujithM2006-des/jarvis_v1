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
        Title="JARVIS onscreen" Width="380" Height="300" WindowStyle="None"
        AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="False" ResizeMode="NoResize">
  <Border CornerRadius="16" BorderThickness="1" BorderBrush="#5519D8D2" Padding="16,12,16,14">
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
        <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
        <Button x:Name="Circle" Grid.Column="0" Content="◯" Width="34" Height="32" FontSize="15" Margin="0,0,8,0"
                Foreground="#19D8D2" Background="#2219D8D2" BorderBrush="#5519D8D2" Cursor="Hand" ToolTip="Circle to search"/>
        <TextBox x:Name="Input" Grid.Column="1" Height="32" Padding="8,6" FontFamily="Segoe UI" FontSize="13"
                 Foreground="#E6FBFF" CaretBrush="#19D8D2" Background="#14FFFFFF" BorderBrush="#3319D8D2"/>
        <Button x:Name="Send" Grid.Column="2" Content="➤" Width="34" Height="32" FontSize="14" Margin="8,0,0,0"
                Foreground="#02121A" Background="#19D8D2" BorderThickness="0" Cursor="Hand" ToolTip="Send"/>
      </Grid>
    </Grid>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}
foreach ($n in 'Header', 'Dot', 'Status', 'Close', 'Scroll', 'Heard', 'Said', 'Circle', 'Input', 'Send') { $el[$n] = $win.FindName($n) }

# Bottom-right, just above the taskbar.
$area = [System.Windows.SystemParameters]::WorkArea
$win.Left = $area.Right - $win.Width - 18
$win.Top = $area.Bottom - $win.Height - 18

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

$labels = @{ dormant = 'standby'; waking = 'listening'; listening = 'listening'; thinking = 'thinking';
             tooling = 'working'; speaking = 'speaking'; boot = 'starting'; offline = 'offline' }
$last = ''
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(450)
$timer.Add_Tick({
  try {
    $s = Invoke-RestMethod -Uri "$bridge/popup/state" -TimeoutSec 1
    $phase = if ($labels.ContainsKey($s.phase)) { $labels[$s.phase] } else { $s.phase }
    if ($s.tool -and $s.phase -eq 'tooling') { $phase = "working · $($s.tool)" }
    $el.Status.Text = "  ·  $phase"
    $el.Dot.Opacity = if ($s.phase -in 'listening', 'waking', 'speaking') { 1 } else { 0.45 }
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

[void]$win.ShowDialog()
