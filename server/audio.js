/**
 * AYA Expo Tools — Audio (Windows Master Volume)
 *
 * Controla o volume master do Windows via Core Audio API (PowerShell).
 * Não gerencia player — o Resolume faz isso. Só controla o volume de saída.
 */

const { execSync, exec } = require('child_process')
const fs = require('fs')
const path = require('path')

// Script PowerShell para controlar volume via Core Audio API
const PS_SCRIPT = path.join(__dirname, '..', 'scripts', 'audio-volume.ps1')

// Escreve o script na primeira inicialização
function ensureScript() {
  const dir = path.dirname(PS_SCRIPT)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(PS_SCRIPT)) {
    fs.writeFileSync(PS_SCRIPT, VOLUME_SCRIPT, 'utf8')
  }
}

const VOLUME_SCRIPT = `
param([string]$Action, [int]$Level = 0)

$code = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid id, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int NotImpl1(); int NotImpl2();
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, Guid ctx);
    int NotImpl3();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    int NotImpl4(); int NotImpl5(); int NotImpl6(); int NotImpl7();
    [PreserveSig] int GetMute(out bool mute);
    [PreserveSig] int SetMute(bool mute, Guid ctx);
}

public class AudioCtrl {
    static IAudioEndpointVolume GetVol() {
        var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
        var iid = typeof(IAudioEndpointVolume).GUID;
        object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
        return (IAudioEndpointVolume)o;
    }
    public static float Get() {
        float l; GetVol().GetMasterVolumeLevelScalar(out l); return l * 100;
    }
    public static void Set(float level) {
        GetVol().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, level)) / 100f, Guid.Empty);
    }
}
'@

Add-Type -TypeDefinition $code -ErrorAction Stop

if ($Action -eq "get") {
    $v = [AudioCtrl]::Get()
    Write-Output ([int][Math]::Round($v))
} elseif ($Action -eq "set") {
    [AudioCtrl]::Set($Level)
    Write-Output ([int]$Level)
} else {
    Write-Output "error:unknown_action"
}
`

let _cachedVolume = null

function runVolumeScript(action, level = 0) {
  ensureScript()
  const args = action === 'set'
    ? `-Action set -Level ${level}`
    : `-Action get`
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${PS_SCRIPT}" ${args}`
  try {
    const out = execSync(cmd, { timeout: 5000, windowsHide: true }).toString().trim()
    const parsed = parseInt(out)
    if (!isNaN(parsed)) return parsed
    console.error(`[Audio] Script returned: ${out}`)
    return null
  } catch (e) {
    console.error(`[Audio] Error: ${e.message}`)
    return null
  }
}

function getVolume() {
  const v = runVolumeScript('get')
  if (v !== null) _cachedVolume = v
  return _cachedVolume ?? 80
}

function setVolume(level) {
  const clamped = Math.max(0, Math.min(100, Math.round(level)))
  const result = runVolumeScript('set', clamped)
  if (result !== null) _cachedVolume = clamped
  return _cachedVolume ?? clamped
}

module.exports = { getVolume, setVolume }
