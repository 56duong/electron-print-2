const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('printerApi', {
  printIp: (config) => ipcRenderer.invoke('print-ip', config),
  testNodeEscposUsb: (config) => ipcRenderer.invoke('test-node-escpos-usb', config),
  listUsbPrinters: () => ipcRenderer.invoke('list-usb-printers'),
  listDirectUsbDevices: () => ipcRenderer.invoke('list-direct-usb-devices'),
  printDirectUsb: (config) => ipcRenderer.invoke('print-direct-usb', config),
  printUsb: (config) => ipcRenderer.invoke('print-usb', config),
  listSerialPorts: () => ipcRenderer.invoke('list-serial-ports'),
  printSerial: (config) => ipcRenderer.invoke('print-serial', config),
  selectBleDevice: (deviceId) => ipcRenderer.send('ble-select', deviceId),
  cancelBleSelection: () => ipcRenderer.send('ble-cancel'),
  onBleDevices: (callback) => {
    const listener = (_event, devices) => callback(devices);
    ipcRenderer.on('ble-devices', listener);
    return () => ipcRenderer.removeListener('ble-devices', listener);
  }
});
