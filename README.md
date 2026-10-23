# Thermal Printer Test (Electron)

A small Electron app for testing basic ESC/POS receipt printing through:

1. **TCP/IP** — sends raw bytes to `host:port`, usually port `9100`.
2. **Direct USB** — enumerates USB devices by VID/PID and attempts raw transfer to a bulk OUT endpoint.
3. **USB / system printer queue** — sends raw ESC/POS bytes to an installed OS printer queue.
4. **Bluetooth Classic SPP** — sends bytes to a serial port exposed by a paired Bluetooth printer.
5. **Bluetooth Low Energy (BLE)** — uses Web Bluetooth to connect to a GATT service and writable characteristic.

## Requirements

- Node.js LTS installed.
- Windows or macOS.
- A printer that accepts ESC/POS commands for the selected transport.

## Run

```bash
npm install
npm start
```

## Build

On Windows:

```bash
npm run build:win
```

On macOS:

```bash
npm run build:mac
```

Build the macOS package on a Mac for the most reliable result. Native dependencies and signing/notarization can make cross-building from Windows unreliable.

## USB printing notes

The app has two USB paths:

- **Direct USB device:** Uses the `usb` (libusb) package to enumerate connected devices and send raw bytes to a bulk OUT endpoint. It does not require the printer to appear in the system printer list, but the device must expose a compatible interface. On Windows, the installed printer driver may own the interface; direct access can require replacing/binding the device to WinUSB or libusbK (for example with a driver utility). This can stop the normal Windows printer queue from working, so do not change the driver on a production printer without understanding the impact.
- **System printer queue:** Sends data through Windows Print Spooler or macOS/Linux CUPS. This does require an installed printer queue.

- **Windows:** the printer must appear in `Get-Printer`. The app uses the Windows spooler `WritePrinter` API with datatype `RAW`.
- **macOS:** the printer must be added in Printers & Scanners and appear in `lpstat -p`. The app submits the bytes with `lp -o raw`.
- Some macOS printer queues/drivers do not accept raw ESC/POS data. If the printer does not support raw data through its queue, use a compatible raw queue/driver or a device-specific USB implementation.

## Bluetooth notes

### Classic Bluetooth (SPP)
Pair the printer in the operating system first, then select its serial/COM port in this app. This is for Classic Bluetooth serial profiles, not BLE.

### BLE
BLE scanning opens a device chooser and lets you select a nearby device; you do not need to enter a MAC address. The app checks common printer service UUIDs and tries to discover writable characteristics. The scan is active only while the device chooser is open; the Refresh list button redraws the latest results, and Cancel / stop scan closes the chooser. Service/characteristic UUID fields are optional advanced fields.

Web Bluetooth restricts access to services that were authorized in the requestDevice call. This starter includes a few standard service UUIDs, but most printer services may be vendor-specific. If the app connects but cannot find a writable characteristic, enter the printer's service UUID and scan/connect again. The characteristic can be left blank to select the first writable characteristic in that service.

The app sends ESC/POS bytes in chunks. Adjust the chunk size to match the printer's limits. Some BLE printers use a proprietary command protocol instead of accepting raw ESC/POS bytes, so generic printing may not work without the manufacturer's protocol.

Web Bluetooth availability depends on the Electron/Chromium build and host platform. Test the BLE flow on the exact Windows and macOS versions you intend to support.

## Important

- This is a starter test utility, not a production print manager.
- Test with a harmless receipt first. Some printers interpret the final `GS V 0` command as a cut command.
- The sample receipt uses UTF-8 text. ESC/POS printers often require a specific code page for Vietnamese or other non-ASCII text; encoding support must be added for your printer.
