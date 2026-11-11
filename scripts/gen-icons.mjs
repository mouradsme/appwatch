// Generates the PWA PNG icons from simple vector shapes (no dependencies).
// Usage: node scripts/gen-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp = (v) => Math.max(0, Math.min(1, v));
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function roundRectDist(px, py, size, r) {
  const qx = Math.abs(px - size / 2) - (size / 2 - r);
  const qy = Math.abs(py - size / 2) - (size / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const PULSE = [[11, 33], [21, 33], [26, 22], [32, 44], [37, 28], [41, 33], [53, 33]];
const GREEN = hex('#3dd68c');
const BG_A = hex('#1a2233');
const BG_B = hex('#0b0f17');

/** mode: 'rounded' (transparent corners), 'full' (full-bleed), 'maskable' (full-bleed, content in safe zone), 'badge' (white glyph) */
function render(size, mode) {
  const out = Buffer.alloc(size * size * 4);
  const u = size / 64; // design units
  const scale = mode === 'maskable' ? 0.78 : mode === 'badge' ? 1.12 : 1;
  const map = ([x, y]) => [size / 2 + (x - 32) * u * scale, size / 2 + (y - 32) * u * scale];
  const pts = PULSE.map(map);
  const lineW = (mode === 'badge' ? 6 : 4) * u * scale;
  const ringR = 21 * u * scale;
  const ringW = 2 * u * scale;
  const SS = 4; // supersampling per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (mode !== 'badge') {
            const inside = mode === 'rounded' ? roundRectDist(px, py, size, 14 * u) <= 0 : true;
            if (inside) {
              const t = clamp((px + py) / (2 * size));
              cr = BG_A[0] + (BG_B[0] - BG_A[0]) * t;
              cg = BG_A[1] + (BG_B[1] - BG_A[1]) * t;
              cb = BG_A[2] + (BG_B[2] - BG_A[2]) * t;
              ca = 1;
              const ringD = Math.abs(Math.hypot(px - size / 2, py - size / 2) - ringR);
              if (ringD <= ringW / 2) {
                const k = 0.22;
                cr = cr * (1 - k) + GREEN[0] * k; cg = cg * (1 - k) + GREEN[1] * k; cb = cb * (1 - k) + GREEN[2] * k;
              }
            }
          }
          let d = Infinity;
          for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(px, py, ...pts[i], ...pts[i + 1]));
          if (d <= lineW / 2) {
            const col = mode === 'badge' ? [255, 255, 255] : GREEN;
            cr = col[0]; cg = col[1]; cb = col[2]; ca = 1;
          }
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, out);
}

const dir = new URL('../public/icons/', import.meta.url);
const files = [
  ['icon-192.png', 192, 'rounded'],
  ['icon-512.png', 512, 'rounded'],
  ['icon-maskable-512.png', 512, 'maskable'],
  ['apple-touch-icon.png', 180, 'full'],
  ['badge-96.png', 96, 'badge'],
  ['favicon-32.png', 32, 'rounded'],
];
for (const [name, size, mode] of files) {
  writeFileSync(new URL(name, dir), render(size, mode));
  console.log('wrote', name);
}
