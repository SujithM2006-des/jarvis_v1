# JARVIS "Circle to Search" overlay.
#
# Freezes the screen, dims it, and lets you draw around anything with the
# mouse. The region you circled is cropped and saved as a PNG; its path is
# printed on stdout for the bridge, which hands it to JARVIS to identify and
# look up. Esc, a right-click or a tiny scribble cancels (prints nothing).
#
# Started by the bridge (POST /circle) — from "circle to search" said out
# loud, or the button on the onscreen popup.

$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class CircleForm : Form {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);

  Bitmap shot;
  Rectangle bounds;
  List<Point> pts = new List<Point>();
  bool drawing;
  public string Result = "";

  public static string Run(string title) {
    SetProcessDPIAware();
    // Out of the way first, so the main JARVIS window isn't what gets circled.
    // Titled with the assistant's name (setup can rename him).
    IntPtr jarvis = FindWindow(null, title);
    if (jarvis == IntPtr.Zero) jarvis = FindWindow(null, "J.A.R.V.I.S.");
    if (jarvis != IntPtr.Zero) { ShowWindow(jarvis, 6); System.Threading.Thread.Sleep(350); }
    var f = new CircleForm();
    Application.Run(f);
    return f.Result;
  }

  CircleForm() {
    bounds = Screen.PrimaryScreen.Bounds;
    shot = new Bitmap(bounds.Width, bounds.Height);
    using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    Bounds = bounds;
    TopMost = true;
    ShowInTaskbar = false;
    DoubleBuffered = true;
    Cursor = Cursors.Cross;
    KeyPreview = true;
    KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape) Close(); };
    MouseDown += (s, e) => {
      if (e.Button == MouseButtons.Right) { Close(); return; }
      drawing = true; pts.Clear(); pts.Add(e.Location); Invalidate();
    };
    MouseMove += (s, e) => { if (drawing) { pts.Add(e.Location); Invalidate(); } };
    MouseUp += (s, e) => { if (drawing) { drawing = false; Finish(); } };
    Shown += (s, e) => { Activate(); Focus(); };
  }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    g.DrawImage(shot, 0, 0);
    using (var dim = new SolidBrush(Color.FromArgb(110, 0, 8, 14))) g.FillRectangle(dim, ClientRectangle);
    g.SmoothingMode = SmoothingMode.AntiAlias;
    if (pts.Count > 1) {
      // The region inside the stroke shows undimmed, as a preview of the crop.
      using (var path = new GraphicsPath()) {
        path.AddLines(pts.ToArray());
        g.SetClip(path);
        g.DrawImage(shot, 0, 0);
        g.ResetClip();
      }
      using (var glow = new Pen(Color.FromArgb(70, 25, 216, 210), 14)) { glow.LineJoin = LineJoin.Round; g.DrawLines(glow, pts.ToArray()); }
      using (var pen = new Pen(Color.FromArgb(255, 25, 216, 210), 4)) { pen.LineJoin = LineJoin.Round; g.DrawLines(pen, pts.ToArray()); }
    }
    var hint = "Circle anything to search   ·   Esc to cancel";
    using (var font = new Font("Segoe UI Semibold", 15f)) {
      var sz = g.MeasureString(hint, font);
      var r = new RectangleF((Width - sz.Width) / 2 - 18, 34, sz.Width + 36, sz.Height + 16);
      using (var bg = new SolidBrush(Color.FromArgb(215, 2, 18, 26))) g.FillRectangle(bg, r);
      using (var bd = new Pen(Color.FromArgb(200, 25, 216, 210), 1.5f)) g.DrawRectangle(bd, r.X, r.Y, r.Width, r.Height);
      using (var fg = new SolidBrush(Color.FromArgb(255, 210, 250, 250))) g.DrawString(hint, font, fg, r.X + 18, r.Y + 8);
    }
  }

  void Finish() {
    if (pts.Count < 5) { Close(); return; }
    int x0 = int.MaxValue, y0 = int.MaxValue, x1 = 0, y1 = 0;
    foreach (var p in pts) { x0 = Math.Min(x0, p.X); y0 = Math.Min(y0, p.Y); x1 = Math.Max(x1, p.X); y1 = Math.Max(y1, p.Y); }
    var r = Rectangle.FromLTRB(x0 - 12, y0 - 12, x1 + 12, y1 + 12);
    r.Intersect(new Rectangle(0, 0, shot.Width, shot.Height));
    if (r.Width < 24 || r.Height < 24) { Close(); return; }
    using (var crop = shot.Clone(r, shot.PixelFormat)) {
      var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "jarvis-circle-" + DateTime.Now.Ticks + ".png");
      crop.Save(path, ImageFormat.Png);
      Result = path;
    }
    Close();
  }
}
'@
# The main window's title: the assistant's name from setup (~/.jarvis/profile.json).
$title = 'J.A.R.V.I.S.'
try {
  $a = ([IO.File]::ReadAllText((Join-Path $env:USERPROFILE '.jarvis\profile.json')) | ConvertFrom-Json).assistant
  if ($a -and "$a".Trim().ToUpper() -ne 'JARVIS') { $title = "$a".Trim().ToUpper() }
} catch {}
[Console]::Out.Write([CircleForm]::Run($title))
