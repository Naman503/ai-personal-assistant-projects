// Generates the extension icons (gradient rounded square + sparkle) as PNGs, no dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const ss = 4; // supersampling
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22;
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // 4-point sparkle: |dx|^p + |dy|^p <= R^p with p < 1 gives concave star arms.
  const star = (x, y, cx, cy, R) => {
    const dx = Math.abs(x - cx) / R;
    const dy = Math.abs(y - cy) / R;
    return Math.pow(dx, 0.5) + Math.pow(dy, 0.5) <= 1;
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let a = 0, rr = 0, gg = 0, bb = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (!inRounded(px, py)) continue;
          const t = (px + py) / (2 * size);
          // violet #7c3aed → fuchsia #d946ef
          let cr = 124 + (217 - 124) * t, cg = 58 + (70 - 58) * t, cb = 237 + (239 - 237) * t;
          if (star(px, py, size * 0.5, size * 0.5, size * 0.34) || star(px, py, size * 0.76, size * 0.26, size * 0.11)) {
            cr = cg = cb = 255;
          }
          rr += cr; gg += cg; bb += cb; a++;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = ss * ss;
      raw[o] = a ? rr / a : 0;
      raw[o + 1] = a ? gg / a : 0;
      raw[o + 2] = a ? bb / a : 0;
      raw[o + 3] = (a / n) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public/icon', { recursive: true });
for (const s of [16, 32, 48, 96, 128]) writeFileSync(`public/icon/${s}.png`, png(s));
console.log('icons written');
