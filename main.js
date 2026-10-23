const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { SerialPort } = require('serialport');
const usb = require('usb');

let mainWindow;
let pendingBluetoothCallback = null;
let bluetoothCallbackTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 800,
    minWidth: 760,
    minHeight: 650,
    title: 'Thermal Printer Test',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');

  // Electron's Web Bluetooth API asks the app to choose one of the discovered devices.
  mainWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pendingBluetoothCallback = callback;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ble-devices', (devices || []).map((device) => ({
        id: device.deviceId,
        name: device.deviceName || 'Unnamed BLE device'
      })));
    }

    clearTimeout(bluetoothCallbackTimer);
    bluetoothCallbackTimer = setTimeout(() => {
      if (pendingBluetoothCallback) {
        pendingBluetoothCallback('');
        pendingBluetoothCallback = null;
      }
    }, 30000);
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('print-ip', async (_event, { host, port, dataBase64 }) => {
  const hostValue = String(host || '').trim();
  const portValue = Number(port || 9100);
  if (!hostValue) throw new Error('Enter the printer IP address or hostname.');
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    throw new Error('Port must be between 1 and 65535.');
  }

  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('Nothing to print.');

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(new Error(`Network printing failed: ${err.message}`));
      else resolve(`Sent ${buffer.length} bytes to ${hostValue}:${portValue}.`);
    };

    socket.setTimeout(10000);
    socket.once('connect', () => socket.write(buffer, (err) => finish(err || null)));
    socket.once('error', finish);
    socket.once('timeout', () => finish(new Error('Connection timed out')));
    socket.connect(portValue, hostValue);
  });
});

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}


const USBPRINT_PS = `
param([string]$Mode, [string]$Path, [string]$DataFile)

[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public class UsbPrint {
  static Guid G = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");

  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVICE_INTERFACE_DATA {
    public int cbSize;
    public Guid InterfaceClassGuid;
    public int Flags;
    public IntPtr Reserved;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct SP_DEVINFO_DATA {
    public int cbSize;
    public Guid ClassGuid;
    public int DevInst;
    public IntPtr Reserved;
  }

  [DllImport("setupapi.dll", SetLastError=true)]
  static extern IntPtr SetupDiGetClassDevs(
    ref Guid g, IntPtr e, IntPtr h, int flags);

  [DllImport("setupapi.dll", SetLastError=true)]
  static extern bool SetupDiEnumDeviceInterfaces(
    IntPtr s, IntPtr d, ref Guid g, int i,
    ref SP_DEVICE_INTERFACE_DATA di);

  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool SetupDiGetDeviceInterfaceDetail(
    IntPtr s, ref SP_DEVICE_INTERFACE_DATA di,
    IntPtr detail, int size, out int req, ref SP_DEVINFO_DATA dd);

  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool SetupDiGetDeviceRegistryProperty(
    IntPtr s, ref SP_DEVINFO_DATA dd, int prop,
    out int type, StringBuilder buf, int size, out int req);

  [DllImport("setupapi.dll")]
  static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(
    string n, uint access, uint share, IntPtr sa,
    uint disp, uint flags, IntPtr t);

  static string Prop(IntPtr set, ref SP_DEVINFO_DATA dd, int prop) {
    int type, req;
    var sb = new StringBuilder(512);

    return SetupDiGetDeviceRegistryProperty(
      set, ref dd, prop, out type, sb, 1024, out req)
      ? sb.ToString() : null;
  }

  public static string[] List() {
    var result = new List<string>();
    Guid g = G;

    // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
    IntPtr set = SetupDiGetClassDevs(
      ref g, IntPtr.Zero, IntPtr.Zero, 0x12);

    if (set == new IntPtr(-1))
      throw new Win32Exception(Marshal.GetLastWin32Error());

    try {
      for (int i = 0; ; i++) {
        var di = new SP_DEVICE_INTERFACE_DATA();
        di.cbSize = Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));

        if (!SetupDiEnumDeviceInterfaces(
          set, IntPtr.Zero, ref g, i, ref di))
          break;

        var dd = new SP_DEVINFO_DATA();
        dd.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));

        int req;
        SetupDiGetDeviceInterfaceDetail(
          set, ref di, IntPtr.Zero, 0, out req, ref dd);

        if (req <= 0) continue;

        IntPtr buf = Marshal.AllocHGlobal(req);

        try {
          Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);

          if (!SetupDiGetDeviceInterfaceDetail(
            set, ref di, buf, req, out req, ref dd))
            continue;

          string path = Marshal.PtrToStringUni(
            new IntPtr(buf.ToInt64() + 4));

          string name =
            Prop(set, ref dd, 0x0C) ??
            Prop(set, ref dd, 0x00) ??
            "USB printer";

          result.Add(path + "\t" + name);
        }
        finally {
          Marshal.FreeHGlobal(buf);
        }
      }
    }
    finally {
      SetupDiDestroyDeviceInfoList(set);
    }

    return result.ToArray();
  }

  public static void Write(string path, byte[] data) {
    SafeFileHandle h = CreateFile(
      path, 0x40000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);

    if (h.IsInvalid)
      throw new Win32Exception(Marshal.GetLastWin32Error());

    using (var fs = new FileStream(h, FileAccess.Write, 4096, false)) {
      fs.Write(data, 0, data.Length);
      fs.Flush();
    }
  }
}
"@

if ($Mode -eq 'list') {
  [UsbPrint]::List()
} else {
  $bytes = [System.IO.File]::ReadAllBytes($DataFile)
  [UsbPrint]::Write($Path, $bytes)
}
`;

const USBPRINT_PATH_RE =
  /^\\\\\?\\usb#.+#\{28d78fad-5a12-11d1-ae5b-0000f803a8c2\}$/i;

async function runUsbPrintScript(mode, devicePath, jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usbprint-'));
  const ps1 = path.join(dir, 'usbprint.ps1');
  const bin = path.join(dir, 'job.bin');

  try {
    fs.writeFileSync(ps1, USBPRINT_PS, 'utf8');

    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', ps1,
      '-Mode', mode
    ];

    if (mode === 'write') {
      fs.writeFileSync(bin, jobs);
      args.push('-Path', devicePath, '-DataFile', bin);
    }

    return await runCommand('powershell.exe', args);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


async function listUsbPrinters() {
  if (process.platform === 'win32') {
    const ps = 'Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress';
    const output = await runCommand('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps
    ]);
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String);
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const output = await runCommand('lpstat', ['-p', '-d']).catch((err) => {
      throw new Error(`Could not list system printer queues. Ensure CUPS/lpstat is installed. ${err.message}`);
    });
    const names = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^printer\s+(.+?)\s+is\s+/);
      if (match) names.push(match[1]);
    }
    return [...new Set(names)];
  }

  throw new Error(`USB printer queues are not supported on ${process.platform}.`);
}

async function printRawToWindowsQueue(printerName, buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thermal-printer-'));
  const dataPath = path.join(tempDir, 'receipt.bin');
  const scriptPath = path.join(tempDir, 'raw-print.ps1');
  fs.writeFileSync(dataPath, buffer);

  const script = String.raw`
param([string]$PrinterName, [string]$FilePath)
$source = @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOC_INFO_1 di);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

  public static void Send(string printerName, byte[] bytes) {
    IntPtr handle;
    if (!OpenPrinter(printerName, out handle, IntPtr.Zero))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter failed");
    try {
      DOC_INFO_1 doc = new DOC_INFO_1();
      doc.pDocName = "Thermal Printer Test";
      doc.pDataType = "RAW";
      doc.pOutputFile = null;
      if (StartDocPrinter(handle, 1, doc) == 0)
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter failed");
      try {
        if (!StartPagePrinter(handle))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter failed");
        try {
          int written;
          if (!WritePrinter(handle, bytes, bytes.Length, out written) || written != bytes.Length)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter failed");
        } finally { EndPagePrinter(handle); }
      } finally { EndDocPrinter(handle); }
    } finally { ClosePrinter(handle); }
  }
}
"@
Add-Type -TypeDefinition $source
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinterHelper]::Send($PrinterName, $bytes)
`;
  fs.writeFileSync(scriptPath, script, 'utf8');

  try {
    await runCommand('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      printerName, dataPath
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function printRawToSystemQueue(printerName, buffer) {
  if (!printerName) throw new Error('Select a printer queue.');
  if (process.platform === 'win32') {
    await printRawToWindowsQueue(printerName, buffer);
    return `Sent ${buffer.length} raw bytes to Windows printer queue "${printerName}".`;
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const tempPath = path.join(os.tmpdir(), `thermal-receipt-${Date.now()}.bin`);
    fs.writeFileSync(tempPath, buffer);
    try {
      await runCommand('lp', ['-d', printerName, '-o', 'raw', tempPath]);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
    return `Submitted ${buffer.length} raw bytes to printer queue "${printerName}".`;
  }

  throw new Error(`System printer queue printing is not supported on ${process.platform}.`);
}

async function listDirectUsbDevices() {
  if (process.platform === 'win32') {
    const output = await runUsbPrintScript('list');
    const devices = [];

    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;

      const separator = line.indexOf('\t');
      if (separator < 0) continue;

      const devicePath = line.slice(0, separator).trim();
      const name = line.slice(separator + 1).trim();

      if (!USBPRINT_PATH_RE.test(devicePath)) continue;

      const match =
        /usb#vid_([0-9a-f]{4})&pid_([0-9a-f]{4})/i.exec(devicePath);

      if (!match) continue;

      const vendorId = match[1].toUpperCase();
      const productId = match[2].toUpperCase();

      const printerName = name || 'USB printer';

      devices.push({
        key: `usbprint:${devicePath}`,
        label: `${printerName} [${vendorId}:${productId}] (direct USB)`
      });
    }

    return devices;
  }

  // macOS/Linux: keep using the existing libusb discovery.
  return usb.getDeviceList()
    .filter((device) => Number(device.deviceAddress) > 0)
    .map((device) => {
      const descriptor = device.deviceDescriptor || {};
      const vendorId = Number(descriptor.idVendor || 0);
      const productId = Number(descriptor.idProduct || 0);

      return {
        key: `${device.busNumber}:${device.deviceAddress}:${vendorId}:${productId}`,
        label: `USB device — VID ${vendorId.toString(16).padStart(4, '0').toUpperCase()} / PID ${productId.toString(16).padStart(4, '0').toUpperCase()}`
      };
    });
}

async function closeUsbDevice(device) {
  if (!device) return;
  for (const iface of device.interfaces || []) {
    if (!iface.claimed) continue;
    await new Promise((resolve) => {
      try { iface.release(true, () => resolve()); } catch (_) { resolve(); }
    });
  }
  try { device.close(); } catch (_) { }
}


async function printDirectUsb(deviceKey, buffer) {
  if (!deviceKey) {
    throw new Error('Select a direct USB device first.');
  }

  if (process.platform === 'win32') {
    if (!deviceKey.startsWith('usbprint:')) {
      throw new Error('Select a Windows direct USB printer from the refreshed list.');
    }

    const devicePath = deviceKey.slice('usbprint:'.length);

    if (!USBPRINT_PATH_RE.test(devicePath)) {
      throw new Error('Invalid USB printer device path.');
    }

    await runUsbPrintScript('write', devicePath, buffer);

    return `Sent ${buffer.length} raw bytes directly to the USB printer.`;
  }

  // Keep your existing non-Windows libusb printing code below this point.
  const device = usb.getDeviceList().find(
    (item) =>
      `${item.busNumber}:${item.deviceAddress}:${item.deviceDescriptor?.idVendor}:${item.deviceDescriptor?.idProduct}` === deviceKey
  );

  if (!device) {
    throw new Error('USB device not found. Unplug it, reconnect it, and refresh the list.');
  }

  device.open();

  try {
    const interfaces = device.interfaces || [];
    let chosen = null;

    for (const iface of interfaces) {
      const endpoints = iface.endpoints || [];

      const endpoint = endpoints.find((ep) => {
        const direction = String(ep.direction || '').toLowerCase();

        const isOut =
          direction === 'out' ||
          (typeof ep.address === 'number' && (ep.address & 0x80) === 0);

        const isBulk =
          ep.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK ||
          ep.transferType === 2;

        return isOut && isBulk;
      });

      if (endpoint) {
        chosen = { iface, endpoint };
        break;
      }
    }

    if (!chosen) {
      throw new Error(
        'No USB bulk OUT endpoint was found. Check the USB endpoint property names.'
      );
    }

    console.log('Selected USB interface:', chosen.iface.id);
    console.log('Selected USB endpoint:', chosen.endpoint.address);

    await new Promise((resolve, reject) => {
      chosen.iface.claim((error) => error ? reject(error) : resolve());
    });

    await new Promise((resolve, reject) => {
      chosen.endpoint.transfer(buffer, (error) =>
        error ? reject(error) : resolve()
      );
    });

    return `Sent ${buffer.length} raw bytes directly to USB.`;
  } finally {
    await closeUsbDevice(device);
  }
}

ipcMain.handle('list-usb-printers', async () => listUsbPrinters());
ipcMain.handle('list-direct-usb-devices', async () => listDirectUsbDevices());
ipcMain.handle('print-direct-usb', async (_event, { deviceKey, dataBase64 }) => {
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('Nothing to print.');
  return printDirectUsb(String(deviceKey || ''), buffer);
});

ipcMain.handle('print-usb', async (_event, { printerName, dataBase64 }) => {
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buffer.length) throw new Error('Nothing to print.');
  return printRawToSystemQueue(String(printerName || ''), buffer);
});

ipcMain.handle('list-serial-ports', async () => {
  const ports = await SerialPort.list();
  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer || '',
    serialNumber: port.serialNumber || '',
    vendorId: port.vendorId || '',
    productId: port.productId || ''
  }));
});

ipcMain.handle('print-serial', async (_event, { path: portPath, baudRate, dataBase64 }) => {
  const buffer = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!portPath) throw new Error('Select a serial/Bluetooth SPP port.');
  if (!buffer.length) throw new Error('Nothing to print.');

  const port = new SerialPort({
    path: String(portPath),
    baudRate: Number(baudRate) || 9600,
    autoOpen: false
  });

  await new Promise((resolve, reject) => {
    port.open((err) => err ? reject(err) : resolve());
  });

  try {
    await new Promise((resolve, reject) => {
      port.write(buffer, (err) => {
        if (err) return reject(err);
        port.drain((drainErr) => drainErr ? reject(drainErr) : resolve());
      });
    });
    return `Sent ${buffer.length} bytes to ${portPath}.`;
  } finally {
    await new Promise((resolve) => {
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    });
  }
});

ipcMain.on('ble-select', (_event, deviceId) => {
  if (pendingBluetoothCallback) {
    clearTimeout(bluetoothCallbackTimer);
    const callback = pendingBluetoothCallback;
    pendingBluetoothCallback = null;
    callback(deviceId || '');
  }
});

ipcMain.on('ble-cancel', () => {
  if (pendingBluetoothCallback) {
    clearTimeout(bluetoothCallbackTimer);
    const callback = pendingBluetoothCallback;
    pendingBluetoothCallback = null;
    callback('');
  }
});
