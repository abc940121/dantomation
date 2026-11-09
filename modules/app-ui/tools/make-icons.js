#!/usr/bin/env node
'use strict';
// Draws the taskmote monogram (a "d": ring plus stem) and writes the PNG icons with only node:zlib.
// Deterministic: same bytes every run. Our own art (MIT).
//   node modules/app-ui/tools/make-icons.js [outDir]     default: modules/app-ui/web/public/icons
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [7, 7, 7];
const FG = [236, 236, 236];
const ACCENT = [86, 156, 255];

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Geometry in a 100x100 box: ring centre (46,54) radius 24..34, stem x 66..76 from y 16 to 88, accent dot in the ring.
function colorAt(x, y) {
  const dx = x - 46, dy = y - 54, d2 = dx * dx + dy * dy;
  if (d2 <= 81) return ACCENT;
  if (d2 >= 576 && d2 <= 1156) return FG;
  if (x >= 66 && x <= 76 && y >= 16 && y <= 88) return FG;
  return BG;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 3);
  const S = 3; // 3x3 supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = colorAt(((x + (sx + 0.5) / S) / size) * 100, ((y + (sy + 0.5) / S) / size) * 100);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = (y * size + x) * 3, n = S * S;
      buf[o] = Math.round(r / n); buf[o + 1] = Math.round(g / n); buf[o + 2] = Math.round(b / n);
    }
  }
  return buf;
}

const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
function svg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">',
    `  <rect width="100" height="100" fill="${hex(BG)}"/>`,
    `  <circle cx="46" cy="54" r="29" fill="none" stroke="${hex(FG)}" stroke-width="10"/>`,
    `  <rect x="66" y="16" width="10" height="72" fill="${hex(FG)}"/>`,
    `  <circle cx="46" cy="54" r="9" fill="${hex(ACCENT)}"/>`,
    '</svg>', '',
  ].join('\n');
}

function build() {
  return {
    'icon.svg': Buffer.from(svg()),
    'icon-192.png': encodePng(192, 192, render(192)),
    'icon-512.png': encodePng(512, 512, render(512)),
    'apple-touch-icon.png': encodePng(180, 180, render(180)),
  };
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'web', 'public', 'icons'));
  fs.mkdirSync(out, { recursive: true });
  for (const [name, data] of Object.entries(build())) fs.writeFileSync(path.join(out, name), data);
  console.log('wrote icons to ' + out);
}
module.exports = { build };
