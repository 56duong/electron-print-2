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
  const body = new TextEncoder().encode(text + '\n\n\n');
  const cut = $('cutPaper').checked ? Uint8Array.of(0x1d, 0x56, 0x00) : new Uint8Array(0); // GS V 0 cut (ignored by some printers)
  return EscPos.concat([Uint8Array.of(0x1b, 0x40), body, cut]); // ESC @ initialize
}

const PAPER_WIDTHS = {
  print_size_k57_3c: 384,
  print_size_k80_3c: 576,
  print_size_k80_4c: 576,
  print_size_a5: 1168,
  print_size_a4: 1656
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the image. Choose a PNG or JPEG file.'));
    image.src = dataUrl;
  });
}

async function makeEscPosImage() {
  const file = $('imageFile').files[0];
  if (!file) throw new Error('Choose an image to print.');

  const image = await loadImage(await readFileAsDataUrl(file));
  const width = PAPER_WIDTHS[$('imagePaper').value] || 576;
  const height = Math.max(1, Math.round(width * image.naturalHeight / image.naturalWidth));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff'; // transparent areas print as white
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  return EscPos.encodeImage(data, width, height, {
    mode: $('imageCommand').value,
    cut: $('cutPaper').checked
  });
}

async function buildPrintData() {
  const copies = Math.max(1, Math.floor(Number($('copies').value) || 1));
  const one = $('printMode').value === 'image' ? await makeEscPosImage() : makeEscPosReceipt();
  return EscPos.concat(Array.from({ length: copies }, () => one));
}

function updatePrintMode() {
  const image = $('printMode').value === 'image';
  $('textOptions').hidden = image;
  $('imageOptions').hidden = !image;
}
$('printMode').addEventListener('change', updatePrintMode);
updatePrintMode();

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
  const dataBase64 = toBase64(await buildPrintData());
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
    dataBase64: toBase64(await buildPrintData())
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
    dataBase64: toBase64(await buildPrintData())
  });
}));

$('printSerial').addEventListener('click', () => withBusy($('printSerial'), async () => {
  const portPath = $('serialPort').value;
  if (!portPath) throw new Error('Select a serial/Bluetooth SPP port first.');
  return window.printerApi.printSerial({
    path: portPath,
    baudRate: $('baudRate').value,
    dataBase64: toBase64(await buildPrintData())
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

  const bytes = await buildPrintData();
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

async function requestArduinoDevice() {
  setTimeout(async () => {
    try {
      const device = await navigator.usb.getDevices();
      console.log('Connected USB devices:', device);
    } catch (error) {
      console.error(error);
    }
  }, 3000);
}

requestArduinoDevice();