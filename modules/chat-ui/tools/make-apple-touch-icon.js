#!/usr/bin/env node
'use strict';
// Writes ui/icons/apple-touch-icon.png: 180x180, full-bleed square (no transparent corners, iOS rounds it itself):
// deep indigo to bright blue, one large white chat bubble with three dots cut out of it. No text. Dependency free
// (zlib only). Run: node modules/chat-ui/tools/make-apple-touch-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 180, TOP = [0x1d, 0x2b, 0x8f], BOT = [0x2f, 0x7b, 0xff], FG = [255, 255, 255];
// bubble: wide rounded rectangle (about 78% of the width) plus a tail at the lower left, centred as a whole
const RX0 = 21, RX1 = 159, RY0 = 36, RY1 = 118, R = 30;
const TAIL = [[44, 108], [44, 150], [84, 112]];
const DOTS = [[64, 77], [90, 77], [116, 77]], DR = 9;

function inRoundRect(x, y) {
  if (x < RX0 || x > RX1 || y < RY0 || y > RY1) return false;
  const cx = x < RX0 + R ? RX0 + R : x > RX1 - R ? RX1 - R : x;
  const cy = y < RY0 + R ? RY0 + R : y > RY1 - R ? RY1 - R : y;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
}
function inTail(x, y) {
  const [a, b, c] = TAIL;
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [x, y], d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const inDot = (x, y) => DOTS.some(d => (x - d[0]) * (x - d[0]) + (y - d[1]) * (y - d[1]) <= DR * DR);
const inBubble = (x, y) => (inRoundRect(x, y) || inTail(x, y)) && !inDot(x, y);

const raw = Buffer.alloc(N * (N * 3 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 3 + 1)] = 0; // filter: none
  const t = y / (N - 1);
  for (let x = 0; x < N; x++) {
    let hit = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (inBubble(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hit++;
    const k = hit / 9, o = y * (N * 3 + 1) + 1 + x * 3;
    for (let c = 0; c < 3; c++) raw[o + c] = Math.round((TOP[c] + (BOT[c] - TOP[c]) * t) + (FG[c] - (TOP[c] + (BOT[c] - TOP[c]) * t)) * k);
  }
}

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'ui', 'icons', 'apple-touch-icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote ' + out + ' (' + png.length + ' bytes)');
