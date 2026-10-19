"use strict";
// 生成 Synapse 扩展图标（靛蓝圆角底 + 白色闪电），输出 16/32/48/128/512 PNG。
// 纯 Node（zlib + 手写 PNG/CRC32），无 canvas 依赖。产物写入 extension/icons/。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---- CRC32（PNG 块校验） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---- 颜色/形状 ----
// 靛蓝垂直渐变底
function bgTop() { return [99, 102, 241]; }    // #6366F1
function bgBot() { return [67, 56, 202]; }     // #4338CA
function lerp(a, b, t) { return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t)); }

// 闪电多边形（单位坐标，y 向下）。经典 ⚡
const BOLT = [
  [0.58, 0.05], [0.28, 0.55], [0.45, 0.55], [0.38, 0.95],
  [0.72, 0.42], [0.54, 0.42], [0.70, 0.05],
];
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 圆角矩形内判定（r=半径，边长 s）
function inRoundedRect(px, py, s, r) {
  const x = px, y = py;
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 渲染一个尺寸（4x 超采样再盒式下采样，抗锯齿）
function renderIcon(size) {
  const S = size * 4;
  const buf = Buffer.alloc(S * S * 4);
  const r = S * 0.2;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const o = (py * S + px) * 4;
      if (!inRoundedRect(px + 0.5, py + 0.5, S, r)) { buf[o + 3] = 0; continue; } // 圆角外透明
      const t = py / S;
      const c = lerp(bgTop(), bgBot(), t);
      // 轻微内阴影：靠近下缘略暗
      const shade = 1 - 0.08 * Math.max(0, (py - S * 0.6) / (S * 0.4));
      let R = c[0] * shade, G = c[1] * shade, B = c[2] * shade;
      // 闪电（白）：把像素映射到单位坐标后判定
      const ux = (px + 0.5) / S, uy = (py + 0.5) / S;
      if (inPolygon(ux, uy, BOLT)) { R = 255; G = 255; B = 255; }
      buf[o] = Math.round(R); buf[o + 1] = Math.round(G); buf[o + 2] = Math.round(B); buf[o + 3] = 255;
    }
  }
  // 盒式下采样 4x4
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const o = ((y * 4 + dy) * S + (x * 4 + dx)) * 4;
        rr += buf[o]; gg += buf[o + 1]; bb += buf[o + 2]; aa += buf[o + 3];
      }
      const o2 = (y * size + x) * 4;
      out[o2] = rr / 16; out[o2 + 1] = gg / 16; out[o2 + 2] = bb / 16; out[o2 + 3] = aa / 16;
    }
  }
  return out;
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128, 512]) {
  const rgba = renderIcon(size);
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, rgba));
  console.log("wrote", file, fs.statSync(file).size + "B");
}
console.log("done");
