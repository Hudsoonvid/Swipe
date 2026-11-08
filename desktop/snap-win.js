// "Snap to buttons" on Windows: when a pen or finger tap just misses a
// button, link, menu item, checkbox, tab or list entry, find it with UI
// Automation and click its center instead. Runs one long-lived hidden
// PowerShell process that answers "x y radius" with "cx cy" or "-".

'use strict';

const { spawn: nodeSpawn } = require('node:child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try {
  Add-Type -Name D -Namespace SwipeDpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);'
  [void][SwipeDpi.D]::SetProcessDpiAwarenessContext([IntPtr]-4)
} catch {}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$T = [System.Windows.Automation.ControlType]
$ok = @($T::Button, $T::Hyperlink, $T::MenuItem, $T::CheckBox, $T::RadioButton, $T::TabItem, $T::ListItem, $T::TreeItem, $T::ComboBox, $T::SplitButton, $T::Edit, $T::DataItem, $T::Slider, $T::Spinner)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Target($x, $y) {
  try { $e = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($x, $y))) } catch { return $null }
  for ($i = 0; $e -and $i -lt 4; $i++) {
    if ($ok -contains $e.Current.ControlType) { return $e }
    $e = $walker.GetParent($e)
  }
  return $null
}
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $a = $line.Split(' '); $id = $a[0]; $x = [double]$a[1]; $y = [double]$a[2]; $r = [double]$a[3]
  $best = '-'; $bd = 1e9
  $h = $r * 0.7
  foreach ($o in @(@(0,0), @($r,0), @(-$r,0), @(0,$r), @(0,-$r), @($h,$h), @(-$h,$h), @($h,-$h), @(-$h,-$h))) {
    $e = Target ($x + $o[0]) ($y + $o[1])
    if (-not $e) { continue }
    $b = $e.Current.BoundingRectangle
    if ($b.IsEmpty -or $b.Width -gt 800 -or $b.Height -gt 400) { continue }
    $dx = [Math]::Max([Math]::Max($b.Left - $x, 0), $x - $b.Right)
    $dy = [Math]::Max([Math]::Max($b.Top - $y, 0), $y - $b.Bottom)
    $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
    if ($d -eq 0) { $best = '='; break }
    if ($d -lt $bd -and $d -le $r) { $bd = $d; $best = '' + [int]($b.X + $b.Width / 2) + ' ' + [int]($b.Y + $b.Height / 2) }
  }
  [Console]::Out.WriteLine($id + ' ' + $best); [Console]::Out.Flush()
}
`;

// find(x, y, r) resolves to {x, y} to click instead, or null to click where tapped.
function createSnapper({ platform = process.platform, spawn = nodeSpawn, timeoutMs = 400 } = {}) {
  if (platform !== 'win32') return null;
  let proc = null;
  let ready = false;
  let buf = '';
  let seq = 0;
  const waiting = new Map();
  const start = () => {
    ready = false;
    buf = '';
    try {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      proc = null;
      return;
    }
    const me = proc;
    me.on('error', () => {});
    me.on('exit', () => {
      if (proc === me) proc = null;
      for (const [, w] of waiting) w(null);
      waiting.clear();
    });
    me.stdout.setEncoding('utf8');
    me.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') {
          ready = true;
          continue;
        }
        const [id, a, b] = line.split(' ');
        const w = waiting.get(id);
        if (!w) continue;
        waiting.delete(id);
        w(a && a !== '-' && a !== '=' && b !== undefined ? { x: Number(a), y: Number(b) } : null);
      }
    });
    me.stdin.on('error', () => {});
  };
  return {
    warm() {
      if (!proc) start();
    },
    find(x, y, r) {
      if (!proc) start();
      if (!proc || !ready) return Promise.resolve(null); // still starting: click where tapped
      const id = String(++seq);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          waiting.delete(id);
          resolve(null);
        }, timeoutMs);
        waiting.set(id, (v) => {
          clearTimeout(t);
          resolve(v);
        });
        try {
          proc.stdin.write(`${id} ${Math.round(x)} ${Math.round(y)} ${Math.round(r)}\n`);
        } catch {
          waiting.delete(id);
          clearTimeout(t);
          resolve(null);
        }
      });
    },
    stop() {
      try {
        proc?.kill();
      } catch {}
      proc = null;
    },
  };
}

module.exports = { createSnapper, SCRIPT };
