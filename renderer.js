const $ = (id) => document.getElementById(id);

let bleDevice = null;
let bleCharacteristic = null;
let bleServer = null;
let bleDeviceList = [];

function setStatus(title, message, kind = '') {
  $('statusTitle').textContent = title;
  $('statusMessage').textContent = message;
  $('statusDot').className = `status-dot ${kind}`;
}

function toBase64(buffer) {
  let binary = '';
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function makeEscPosReceipt() {
  const text = $('receiptText').value.replace(/\r\n/g, '\n');
  const encoder = new TextEncoder();
  const body = encoder.encode(text + '\n\n\n');
  const output = new Uint8Array(2 + body.length + 3);
  output.set([0x1b, 0x40], 0); // ESC @ initialize
  output.set(body, 2);
  output.set([0x1d, 0x56, 0x00], 2 + body.length); // GS V 0 cut (ignored by some printers)
  return output;
}

async function withBusy(button, action) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    const result = await action();
    setStatus('Success', result, 'ok');
  } catch (error) {
    setStatus('Failed', error?.message || String(error), 'error');
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function refreshUsbPrinters() {
  const select = $('usbPrinter');
  select.innerHTML = '';
  try {
    const printers = await window.printerApi.listUsbPrinters();
    if (!printers.length) {
      select.add(new Option('No system printer queues found', ''));
      return;
    }
    select.add(new Option('Select printer…', ''));
    printers.forEach((name) => select.add(new Option(name, name)));
    setStatus('Ready', `Found ${printers.length} printer queue(s).`);
  } catch (error) {
    select.add(new Option('Could not list printers', ''));
    setStatus('Printer listing failed', error.message || String(error), 'error');
  }
}

async function refreshSerialPorts() {
  const select = $('serialPort');
  select.innerHTML = '';
  try {
    const ports = await window.printerApi.listSerialPorts();
    if (!ports.length) {
      select.add(new Option('No serial ports found', ''));
      return;
    }
    select.add(new Option('Select port…', ''));
    ports.forEach((port) => {
      const description = [port.path, port.manufacturer, port.vendorId && `VID ${port.vendorId}`, port.productId && `PID ${port.productId}`]
        .filter(Boolean).join(' — ');
      select.add(new Option(description, port.path));
    });
    setStatus('Ready', `Found ${ports.length} serial port(s).`);
  } catch (error) {
    select.add(new Option('Could not list serial ports', ''));
    setStatus('Serial port listing failed', error.message || String(error), 'error');
  }
}

$('printIp').addEventListener('click', () => withBusy($('printIp'), async () => {
  const dataBase64 = toBase64(makeEscPosReceipt());
  return window.printerApi.printIp({
    host: $('ipHost').value,
    port: $('ipPort').value,
    dataBase64
  });
}));

$('printUsb').addEventListener('click', () => withBusy($('printUsb'), async () => {
  const printerName = $('usbPrinter').value;
  if (!printerName) throw new Error('Select a printer queue first.');
  return window.printerApi.printUsb({
    printerName,
    dataBase64: toBase64(makeEscPosReceipt())
  });
}));


async function refreshDirectUsbDevices() {
  const select = $('directUsbDevice');
  select.innerHTML = '';
  try {
    const devices = await window.printerApi.listDirectUsbDevices();
    if (!devices.length) {
      select.add(new Option('No USB devices found', ''));
      return;
    }
    select.add(new Option('Select USB device…', ''));
    devices.forEach((device) => select.add(new Option(device.label, device.key)));
    setStatus('Ready', `Found ${devices.length} USB device(s).`);
  } catch (error) {
    select.add(new Option('Could not list USB devices', ''));
    setStatus('USB device listing failed', error.message || String(error), 'error');
  }
}

$('refreshDirectUsb').addEventListener('click', () => withBusy($('refreshDirectUsb'), refreshDirectUsbDevices));
$('printDirectUsb').addEventListener('click', () => withBusy($('printDirectUsb'), async () => {
  const deviceKey = $('directUsbDevice').value;
  if (!deviceKey) throw new Error('Select a direct USB device first.');
  return window.printerApi.printDirectUsb({
    deviceKey,
    dataBase64: toBase64(makeEscPosReceipt())
  });
}));

function readSelectedImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve('');
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected image.'));
    reader.readAsDataURL(file);
  });
}

$('printNodeEscposUsb').addEventListener('click', () => withBusy($('printNodeEscposUsb'), async () => {
  const vendorId = $('escposVendorId').value.trim();
  const productId = $('escposProductId').value.trim();
  if (Boolean(vendorId) !== Boolean(productId)) {
    throw new Error('Enter both Vendor ID and Product ID, or leave both blank.');
  }
  const imageFile = $('escposImage').files && $('escposImage').files[0];
  const imageDataUrl = await readSelectedImageAsDataUrl(imageFile);
  return window.printerApi.testNodeEscposUsb({
    vendorId,
    productId,
    receiptText: $('escposReceiptText').value,
    imageDataUrl
  });
}));

$('printSerial').addEventListener('click', () => withBusy($('printSerial'), async () => {
  const portPath = $('serialPort').value;
  if (!portPath) throw new Error('Select a serial/Bluetooth SPP port first.');
  return window.printerApi.printSerial({
    path: portPath,
    baudRate: $('baudRate').value,
    dataBase64: toBase64(makeEscPosReceipt())
  });
}));

async function chooseBleDevice() {
  if (!navigator.bluetooth) {
    throw new Error('Web Bluetooth is unavailable in this Electron build or on this platform.');
  }

  const requestedService = $('bleService').value.trim();
  // Web Bluetooth only exposes services listed here. These include common
  // printer/vendor UUIDs; individual printer models may use different UUIDs.
  const optionalServices = [
    'battery_service',
    'device_information',
    'generic_access',
    'generic_attribute',
    '0000ff00-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ae00-0000-1000-8000-00805f9b34fb',
    '000018f0-0000-1000-8000-00805f9b34fb'
  ];
  if (requestedService && !optionalServices.includes(requestedService.toLowerCase())) {
    optionalServices.push(requestedService);
  }

  $('bleDeviceList').innerHTML = '';
  $('bleDialog').showModal();
  $('bleStatus').textContent = 'Scanning for nearby BLE devices… choose your printer in the device list.';

  try {
    // The Electron select-bluetooth-device event forwards discovered devices to this dialog.
    // No MAC address is required; the user selects a device discovered by the BLE scan.
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices
    });

    $('bleDialog').close();
    bleDevice = device;
    bleDevice.addEventListener('gattserverdisconnected', () => {
      bleServer = null;
      bleCharacteristic = null;
      $('printBle').disabled = true;
      $('bleStatus').textContent = 'Printer disconnected.';
    });

    bleServer = await bleDevice.gatt.connect();
    let services;
    try {
      services = requestedService
        ? [await bleServer.getPrimaryService(requestedService)]
        : await bleServer.getPrimaryServices();
    } catch (serviceError) {
      throw new Error(
        `Connected to ${bleDevice.name || 'BLE device'}, but service discovery failed: ${serviceError.message}. ` +
        'This usually means the printer uses a service UUID not included in the app permission list. ' +
        'Enter the printer service UUID and connect again.'
      );
    }

    if (!services.length) {
      throw new Error(
        'Connected, but no accessible GATT services were found. Common printer services were checked. ' +
        'This printer may use a different custom service UUID, or may not support BLE printing through GATT. ' +
        'The printer model or its BLE service UUID is needed to continue.'
      );
    }

    let selectedCharacteristic = null;
    let selectedServiceUuid = '';

    for (const service of services) {
      console.log('BLE service:', service.uuid);
      let characteristics;
      try {
        characteristics = await service.getCharacteristics();
      } catch (error) {
        console.warn('Could not read characteristics for service', service.uuid, error);
        continue;
      }

      for (const characteristic of characteristics) {
        console.log('BLE characteristic:', {
          service: service.uuid,
          uuid: characteristic.uuid,
          write: characteristic.properties.write,
          writeWithoutResponse: characteristic.properties.writeWithoutResponse,
          notify: characteristic.properties.notify
        });

        const requestedCharacteristic = $('bleCharacteristic').value.trim().toLowerCase();
        const matchesRequested = !requestedCharacteristic ||
          characteristic.uuid.toLowerCase() === requestedCharacteristic;
        if (
          matchesRequested &&
          (characteristic.properties.write || characteristic.properties.writeWithoutResponse)
        ) {
          selectedCharacteristic = characteristic;
          selectedServiceUuid = service.uuid;
          break;
        }
      }
      if (selectedCharacteristic) break;
    }

    if (!selectedCharacteristic) {
      throw new Error(
        `Connected and found ${services.length} accessible service(s), but none had a writable characteristic. ` +
        'The printer may use another custom service/characteristic UUID, or a proprietary BLE print protocol. ' +
        'Check the service UUIDs logged in DevTools or provide the printer model.'
      );
    }

    bleCharacteristic = selectedCharacteristic;
    $('bleService').value = selectedServiceUuid;
    $('bleCharacteristic').value = bleCharacteristic.uuid;
    $('bleStatus').textContent =
      `Connected to ${bleDevice.name || 'BLE device'} · Service ${selectedServiceUuid} · Characteristic ${bleCharacteristic.uuid}`;
    $('printBle').disabled = false;
    return `Connected to ${bleDevice.name || 'BLE device'} and found a writable characteristic.`;
  } catch (error) {
    $('bleDialog').close();
    window.printerApi.cancelBleSelection();
    bleServer = null;
    bleCharacteristic = null;
    $('printBle').disabled = true;
    throw error;
  }
}

$('connectBle').addEventListener('click', () => withBusy($('connectBle'), chooseBleDevice));

function renderBleDeviceList() {
  const container = $('bleDeviceList');
  container.innerHTML = '';

  if (!bleDeviceList.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No devices discovered yet. Keep the printer on and click Refresh list.';
    container.appendChild(empty);
    return;
  }

  bleDeviceList.forEach((device) => {
    const button = document.createElement('button');
    button.className = 'device-option';
    const name = document.createElement('span');
    name.textContent = device.name || 'Unnamed BLE device';
    const id = document.createElement('small');
    id.textContent = device.id;
    button.append(name, id);
    button.addEventListener('click', () => window.printerApi.selectBleDevice(device.id));
    container.appendChild(button);
  });
}

window.printerApi.onBleDevices((devices) => {
  bleDeviceList = devices || [];
  if ($('bleDialog').open) renderBleDeviceList();
});

$('refreshBleList').addEventListener('click', () => {
  // Web Bluetooth scans only while requestDevice's chooser is active. The list
  // is normally updated automatically; this button redraws the latest results.
  renderBleDeviceList();
  $('bleStatus').textContent = 'Device scan is active while this dialog is open. The list has been refreshed.';
});

$('cancelBle').addEventListener('click', () => {
  window.printerApi.cancelBleSelection();
  $('bleDialog').close();
});

$('printBle').addEventListener('click', () => withBusy($('printBle'), async () => {
  if (!bleDevice || !bleServer?.connected || !bleCharacteristic) {
    throw new Error('Connect to the BLE printer first.');
  }

  const bytes = makeEscPosReceipt();
  const chunkSize = Math.max(20, Math.min(512, Number($('bleChunk').value) || 180));
  const useResponse = Boolean(bleCharacteristic.properties.write);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
    if (useResponse && bleCharacteristic.writeValueWithResponse) {
      await bleCharacteristic.writeValueWithResponse(chunk);
    } else if (bleCharacteristic.writeValueWithoutResponse) {
      await bleCharacteristic.writeValueWithoutResponse(chunk);
    } else {
      await bleCharacteristic.writeValue(chunk);
    }
    // Give small BLE printer buffers time to drain.
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  return `Sent ${bytes.length} bytes to ${bleDevice.name || 'BLE printer'} in ${Math.ceil(bytes.length / chunkSize)} chunk(s).`;
}));

$('refreshUsb').addEventListener('click', refreshUsbPrinters);
$('refreshSerial').addEventListener('click', refreshSerialPorts);
$('refreshAll').addEventListener('click', async () => {
  await Promise.all([refreshDirectUsbDevices(), refreshUsbPrinters(), refreshSerialPorts()]);
});

refreshDirectUsbDevices();
refreshUsbPrinters();
refreshSerialPorts();
