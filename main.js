const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { SerialPort } = require('serialport');
const usb = require('usb');
const { Printer, Image } = require('@node-escpos/core');
const USBAdapter = require('@node-escpos/usb-adapter');

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

ipcMain.handle('test-node-escpos-usb', async (_event, { receiptText, vendorId, productId, imageDataUrl }) => {
  const text = String(receiptText || 'NODE-ESCPOS USB TEST\n\nHello from Electron!');
  const vid = String(vendorId || '').trim() ? Number.parseInt(String(vendorId).trim().replace(/^0x/i, ''), 16) : null;
  const pid = String(productId || '').trim() ? Number.parseInt(String(productId).trim().replace(/^0x/i, ''), 16) : null;

  if (vid !== null && (!Number.isInteger(vid) || vid < 0 || vid > 0xffff)) {
    throw new Error('Vendor ID must be a 4-digit hexadecimal value, for example 1FC9.');
  }
  if (pid !== null && (!Number.isInteger(pid) || pid < 0 || pid > 0xffff)) {
    throw new Error('Product ID must be a 4-digit hexadecimal value, for example 2016.');
  }
  if ((vid === null) !== (pid === null)) {
    throw new Error('Enter both Vendor ID and Product ID, or leave both blank for automatic discovery.');
  }

  let imagePath = null;
  let device = null;
  let opened = false;
  try {
    if (imageDataUrl) {
      const match = /^data:image\/(png|jpeg|jpg);base64,([\s\S]+)$/i.exec(String(imageDataUrl));
      if (!match) throw new Error('The image must be a PNG or JPEG file.');
      const extension = match[1].toLowerCase() === 'png' ? '.png' : '.jpg';
      imagePath = path.join(os.tmpdir(), `node-escpos-test-${Date.now()}${extension}`);
      fs.writeFileSync(imagePath, Buffer.from(match[2], 'base64'));
    }

    // Blank VID/PID lets the adapter discover the first compatible USB printer.
    device = vid === null ? new USBAdapter() : new USBAdapter(vid, pid);
    await new Promise((resolve, reject) => {
      device.open((error) => error ? reject(error) : resolve());
    });
    opened = true;

    let printer = new Printer(device, { encoding: 'GB18030' });
    printer
      .align('ct')
      .text('NODE-ESCPOS USB TEST')
      .align('lt')
      .text(text);

    if (imagePath) {
      const image = await Image.load(imagePath);
      printer.align('ct');
      printer = await printer.image(image, 's8');
    }

    printer.cut().close();
    return `node-escpos USB test sent${imagePath ? ' with image' : ''}${vid !== null ? ` to VID ${vid.toString(16).toUpperCase()} / PID ${pid.toString(16).toUpperCase()}` : ' using automatic USB discovery'}.`;
  } catch (error) {
    if (device && !opened) {
      try { device.close(); } catch (_) {}
    } else if (device && opened) {
      try { device.close(); } catch (_) {}
    }
    const message = error && error.message ? error.message : String(error);
    throw new Error(`node-escpos USB adapter failed: ${message}`);
  } finally {
    if (imagePath) {
      try { fs.rmSync(imagePath, { force: true }); } catch (_) {}
    }
  }
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


function directUsbDeviceKey(device) {
  const descriptor = device.deviceDescriptor || {};
  return `${device.busNumber}:${device.deviceAddress}:${descriptor.idVendor}:${descriptor.idProduct}`;
}

async function listDirectUsbDevices() {
  return usb.getDeviceList().map((device) => {
    const descriptor = device.deviceDescriptor || {};
    const vendorId = Number(descriptor.idVendor || 0);
    const productId = Number(descriptor.idProduct || 0);
    return {
      key: directUsbDeviceKey(device),
      busNumber: device.busNumber,
      deviceAddress: device.deviceAddress,
      vendorId,
      productId,
      label: `USB device — VID ${vendorId.toString(16).padStart(4, '0').toUpperCase()} / PID ${productId.toString(16).padStart(4, '0').toUpperCase()} (Bus ${device.busNumber}, Address ${device.deviceAddress})`
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
  try { device.close(); } catch (_) {}
}

async function printDirectUsb(deviceKey, buffer) {
  if (!deviceKey) throw new Error('Select a direct USB device first.');
  const device = usb.getDeviceList().find((item) => directUsbDeviceKey(item) === deviceKey);
  if (!device) throw new Error('USB device not found. Unplug/reconnect it and refresh the USB device list.');

  device.open();
  try {
    const interfaces = device.interfaces || [];
    let chosen = null;
    for (const iface of interfaces) {
      const endpoint = (iface.endpoints || []).find((item) =>
        item.direction === 'out' && item.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK
      );
      if (endpoint) {
        chosen = { iface, endpoint };
        break;
      }
    }
    if (!chosen) {
      throw new Error('No USB bulk OUT endpoint was found. This device may not expose a raw USB printer interface.');
    }

    try {
      await new Promise((resolve, reject) => {
        chosen.iface.claim((err) => err ? reject(err) : resolve());
      });
    } catch (err) {
      throw new Error(`Could not claim USB interface: ${err.message}. On Windows, the printer driver may own this interface; direct USB access may require a compatible WinUSB/libusb driver.`);
    }

    await new Promise((resolve, reject) => {
      chosen.endpoint.transfer(buffer, (err) => err ? reject(err) : resolve());
    });
    const vendorId = Number(device.deviceDescriptor.idVendor || 0).toString(16).padStart(4, '0').toUpperCase();
    const productId = Number(device.deviceDescriptor.idProduct || 0).toString(16).padStart(4, '0').toUpperCase();
    return `Sent ${buffer.length} raw bytes directly to USB device (VID ${vendorId}, PID ${productId}).`;
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
