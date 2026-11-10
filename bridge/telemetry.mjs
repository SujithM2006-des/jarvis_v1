import os from 'node:os'
import { ps } from './pc.mjs'
import { upcoming, weatherData } from './assistant.mjs'

/**
 * Live readings for the HUD's gauges, served at GET /status.
 *
 * CPU and memory come from Node and cost nothing, so they are fresh on every
 * poll. Battery, Wi-Fi and disk need PowerShell, which takes a second to start,
 * so they are refreshed in the background at most every 30 seconds and the
 * last reading is served in between. Weather is cached for fifteen minutes in
 * assistant.mjs. A poll never waits on any of the slow ones.
 */

let lastCpu = os.cpus()

function cpuPercent() {
  const now = os.cpus()
  let idle = 0
  let total = 0
  now.forEach((c, i) => {
    const p = lastCpu[i]?.times
    if (!p) return
    for (const k of Object.keys(c.times)) total += c.times[k] - p[k]
    idle += c.times.idle - p.idle
  })
  lastCpu = now
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0
}

let slow = { at: 0, data: { battery: null, charging: false, wifi: null, signal: null, diskFree: null, diskTotal: null } }
let slowBusy = false

async function refreshSlow() {
  if (slowBusy || Date.now() - slow.at < 30_000) return
  slowBusy = true
  try {
    const json = await ps(`
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
$w = netsh wlan show interfaces 2>$null | Out-String
$d = Get-PSDrive C
[pscustomobject]@{
  battery  = if ($b) { [int]$b.EstimatedChargeRemaining } else { $null }
  charging = if ($b) { @(2,3,6,7,8,9) -contains [int]$b.BatteryStatus } else { $true }
  wifi     = [regex]::Match($w, '(?m)^\\s*SSID\\s*:\\s*(.+)$').Groups[1].Value.Trim()
  signal   = [regex]::Match($w, '(?m)^\\s*Signal\\s*:\\s*(\\d+)').Groups[1].Value
  diskFree = [math]::Round($d.Free / 1GB, 1)
  diskTotal = [math]::Round(($d.Used + $d.Free) / 1GB, 0)
} | ConvertTo-Json -Compress`)
    const v = JSON.parse(json)
    slow = {
      at: Date.now(),
      data: {
        battery: v.battery,
        charging: Boolean(v.charging),
        wifi: v.wifi || null,
        signal: v.signal ? Number(v.signal) : null,
        diskFree: v.diskFree,
        diskTotal: v.diskTotal,
      },
    }
  } catch (err) {
    console.warn(`[jarvis] status refresh failed: ${err.message}`)
    slow.at = Date.now()
  } finally {
    slowBusy = false
  }
}

let weather = null
let weatherBusy = false
async function refreshWeather() {
  if (weatherBusy) return
  weatherBusy = true
  try {
    weather = await weatherData()
  } catch {
    /* keep the last reading */
  } finally {
    weatherBusy = false
  }
}

export function status() {
  void refreshSlow()
  void refreshWeather()
  const total = os.totalmem()
  return {
    time: Date.now(),
    cpu: cpuPercent(),
    cores: os.cpus().length,
    cpuModel: (os.cpus()[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
    memUsed: +((total - os.freemem()) / 1024 ** 3).toFixed(1),
    memTotal: +(total / 1024 ** 3).toFixed(1),
    uptime: Math.round(os.uptime()),
    host: os.hostname(),
    user: os.userInfo().username,
    ...slow.data,
    weather,
    reminders: upcoming(4),
  }
}
