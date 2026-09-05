// Generates tray icons as real PNG files so the repo carries no binary blobs.
// Run automatically on postinstall; also `npm run icons`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coverage mask for the glyph: a rounded outline bar with three inner bars.
// Supersampled 4x so the edges are not jagged at 16px.
function coverage(size) {
  const S = 4, N = size * S;
  const cov = new Float32Array(size * size);
  const inRounded = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const u = N / 32; // work in a 32-unit design space
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const x = px + 0.5, y = py + 0.5;
      let hit = false;
      // outer bar 2..30 x 8..24, minus inner 4..28 x 10..22  => a 2px frame
      if (inRounded(x, y, 2 * u, 8 * u, 30 * u, 24 * u, 4 * u) &&
          !inRounded(x, y, 4.6 * u, 10.6 * u, 27.4 * u, 21.4 * u, 2.6 * u)) hit = true;
      // three inner bars of rising height, like a level meter
      const bars = [[8, 16.5], [14.5, 14.5], [21, 12.5]];
      for (const [bx, top] of bars) {
        if (x >= bx * u && x <= (bx + 3) * u && y >= top * u && y <= 19.5 * u) hit = true;
      }
      if (hit) cov[Math.floor(py / S) * size + Math.floor(px / S)] += 1 / (S * S);
    }
  }
  return cov;
}

function render(size, rgb) {
  const cov = coverage(size);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, cov[i]);
    buf[i * 4] = rgb[0];
    buf[i * 4 + 1] = rgb[1];
    buf[i * 4 + 2] = rgb[2];
    buf[i * 4 + 3] = Math.round(a * 255);
  }
  return encodePng(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
// macOS wants a template image (pure black + alpha); the system recolours it.
fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), render(16, [0, 0, 0]));
fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), render(32, [0, 0, 0]));
// Windows/Linux trays do not recolour, so use an accent that reads on light and dark.
fs.writeFileSync(path.join(OUT, 'tray.png'), render(16, [77, 163, 255]));
fs.writeFileSync(path.join(OUT, 'tray@2x.png'), render(32, [77, 163, 255]));
// electron-builder wants 512px or larger to derive .ico and .icns from.
fs.writeFileSync(path.join(OUT, 'icon.png'), render(512, [77, 163, 255]));
console.log('[icons] wrote tray icons to assets/');
