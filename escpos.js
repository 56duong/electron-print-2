/* ESC/POS image encoding for thermal printers.
 * Works in the renderer (window.EscPos) and in Node (require) so it can be tested.
 */
(function (root) {
  const THRESHOLD = 180; // brightness below this prints black

  function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  // rgba: Uint8ClampedArray/Uint8Array of width*height*4, already composited on white.
  function rgbaToMono(rgba, width, height) {
    const mono = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < mono.length; i += 1, p += 4) {
      const brightness = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
      mono[i] = brightness < THRESHOLD ? 1 : 0;
    }
    return mono;
  }

  // GS v 0, sent in bands of 256 rows so large images stay within printer limits.
  function encodeRaster(mono, width, height) {
    const bytesPerRow = Math.ceil(width / 8);
    const parts = [Uint8Array.of(0x1b, 0x40)];
    for (let y0 = 0; y0 < height; y0 += 256) {
      const rows = Math.min(256, height - y0);
      const data = new Uint8Array(bytesPerRow * rows);
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (mono[(y0 + y) * width + x]) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
      parts.push(Uint8Array.of(0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8), data);
    }
    return parts;
  }

  // ESC * 33: 24-dot double-density bit image, one 24-row band per line. For printers without GS v 0.
  function encodeBitImage(mono, width, height) {
    const parts = [Uint8Array.of(0x1b, 0x40, 0x1b, 0x33, 0x00)]; // init, line spacing 0
    for (let y0 = 0; y0 < height; y0 += 24) {
      const band = new Uint8Array(width * 3);
      for (let x = 0; x < width; x += 1) {
        for (let k = 0; k < 3; k += 1) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit += 1) {
            const y = y0 + k * 8 + bit;
            if (y < height && mono[y * width + x]) byte |= 0x80 >> bit;
          }
          band[x * 3 + k] = byte;
        }
      }
      parts.push(Uint8Array.of(0x1b, 0x2a, 0x21, width & 0xff, width >> 8), band, Uint8Array.of(0x0a));
    }
    parts.push(Uint8Array.of(0x1b, 0x32)); // restore default line spacing
    return parts;
  }

  // Feed 1 line, then full cut only if requested.
  function trailer(cut) {
    return cut ? Uint8Array.of(0x0a, 0x1d, 0x56, 0x00) : Uint8Array.of(0x0a);
  }

  function encodeImage(rgba, width, height, { mode = 'raster', cut = true } = {}) {
    const mono = rgbaToMono(rgba, width, height);
    const body = mode === 'bitimage' ? encodeBitImage(mono, width, height) : encodeRaster(mono, width, height);
    return concat([...body, trailer(cut)]);
  }

  const api = { concat, rgbaToMono, encodeImage, trailer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EscPos = api;
})(typeof window !== 'undefined' ? window : globalThis);