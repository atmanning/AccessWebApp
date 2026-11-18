/**
 * Pictures from Access designs (logos and other pictures placed on forms and reports), turned
 * into a format browsers show. Access keeps them as a shared image (PNG, JPEG, BMP…) or as the
 * control's own picture data: usually an EMF metafile wrapping a bitmap, which becomes a PNG.
 */
import zlib from "node:zlib";
import { imageType } from "./images.js";

/** A picture as PNG/JPEG/GIF/WebP bytes, or null when it can't be read. */
export function browserPicture(data: Buffer): { mime: string; data: Buffer } | null {
  const direct = imageType(data);
  if (direct) return { mime: direct, data };
  // A BMP file, or a bare DIB.
  if (data.length > 54 && data[0] === 0x42 && data[1] === 0x4d) return png(dibToRgba(data, 14, data.readUInt32LE(10)));
  // An EMF metafile (record 1, " EMF" at byte 40), possibly after a small header.
  for (let off = 0; off < Math.min(64, data.length - 44); off++) {
    if (data.readUInt32LE(off) === 1 && data.toString("latin1", off + 40, off + 44) === " EMF") return png(emfBitmap(data, off));
  }
  // A picture embedded somewhere inside (EMF+ records, OLE wrappers).
  for (const sig of [Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("ffd8ffe0", "hex"), Buffer.from("ffd8ffe1", "hex")]) {
    const at = data.indexOf(sig);
    if (at > 0) {
      const inner = data.subarray(at);
      const t = imageType(inner);
      if (t) return { mime: t, data: inner };
    }
  }
  return null;
}

interface Rgba {
  w: number;
  h: number;
  px: Buffer;
}

/** The largest bitmap an EMF draws (EMR_STRETCHDIBITS / EMR_SETDIBITSTODEVICE / EMR_BITBLT / EMR_STRETCHBLT). */
function emfBitmap(b: Buffer, start: number): Rgba | null {
  let best: (Rgba & { rank: number }) | null = null;
  for (let p = start; p + 8 <= b.length; ) {
    const type = b.readUInt32LE(p);
    const size = b.readUInt32LE(p + 4);
    if (size < 8 || p + size > b.length) break;
    // Offsets of the BITMAPINFO and the bits, relative to the record, by record type.
    const at: Record<number, [number, number, number]> = { 81: [48, 52, 56], 80: [48, 52, 56], 76: [84, 88, 92], 77: [84, 88, 92] };
    const o = at[type];
    if (o) {
      const offBmi = b.readUInt32LE(p + o[0]);
      const cbBmi = b.readUInt32LE(p + o[1]);
      const offBits = b.readUInt32LE(p + o[2]);
      if (cbBmi >= 12 && offBmi && offBits && p + offBits < p + size) {
        try {
          const img = dibToRgba(b.subarray(p, p + size), offBmi, offBits);
          // DIB records (81, 80) hold the picture; BitBlt records (76, 77) are often masks or backgrounds.
          const rank = (t: number) => (t === 81 || t === 80 ? 1 : 0);
          if (img && (!best || rank(type) > best.rank || (rank(type) === best.rank && img.w * img.h > best.w * best.h))) best = { ...img, rank: rank(type) };
        } catch {
          /* a bitmap we can't read */
        }
      }
    }
    if (type === 14) break; // EMR_EOF
    p += size;
  }
  return best;
}

/** A device-independent bitmap (header at `hdr`, pixels at `bits`) as RGBA pixels. */
function dibToRgba(b: Buffer, hdr: number, bits: number): Rgba | null {
  const hs = b.readUInt32LE(hdr);
  const core = hs === 12;
  const w = core ? b.readUInt16LE(hdr + 4) : b.readInt32LE(hdr + 4);
  const rawH = core ? b.readInt16LE(hdr + 6) : b.readInt32LE(hdr + 8);
  const bpp = core ? b.readUInt16LE(hdr + 10) : b.readUInt16LE(hdr + 14);
  const compression = core ? 0 : b.readUInt32LE(hdr + 16);
  const h = Math.abs(rawH);
  const topDown = rawH < 0;
  if (w <= 0 || h <= 0 || w * h > 16_000_000 || ![1, 4, 8, 16, 24, 32].includes(bpp) || (compression !== 0 && compression !== 3 && compression !== 6)) return null;
  const clrUsed = core ? 0 : b.readUInt32LE(hdr + 32);
  const palette: number[][] = [];
  if (bpp <= 8) {
    const n = clrUsed || 1 << bpp;
    const entry = core ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const q = hdr + hs + i * entry;
      palette.push([b[q + 2], b[q + 1], b[q]]);
    }
  }
  let masks: [number, number, number, number] | null = null;
  if (compression === 3 || compression === 6) {
    const m = hs >= 52 ? hdr + 40 : hdr + hs;
    masks = [b.readUInt32LE(m), b.readUInt32LE(m + 4), b.readUInt32LE(m + 8), hs >= 56 || compression === 6 ? b.readUInt32LE(m + 12) : 0];
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
  const channel = (v: number, mask: number) => {
    if (!mask) return 255;
    let shift = 0;
    while (!((mask >>> shift) & 1)) shift++;
    const max = mask >>> shift;
    return Math.round((((v & mask) >>> shift) * 255) / max);
  };
  const stride = Math.floor((w * bpp + 31) / 32) * 4;
  if (bits + stride * h > b.length) return null;
  const px = Buffer.alloc(w * h * 4);
  let alphaSeen = false;
  for (let y = 0; y < h; y++) {
    const row = bits + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r: number, g: number, bl: number, a = 255;
      if (bpp <= 8) {
        const bitPos = x * bpp;
        const byte = b[row + (bitPos >> 3)];
        const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        [r, g, bl] = palette[idx] ?? [0, 0, 0];
      } else if (bpp === 24) {
        const q = row + x * 3;
        [bl, g, r] = [b[q], b[q + 1], b[q + 2]];
      } else if (bpp === 16) {
        const v = b.readUInt16LE(row + x * 2);
        [r, g, bl] = [channel(v, masks![0]), channel(v, masks![1]), channel(v, masks![2])];
      } else {
        const v = b.readUInt32LE(row + x * 4);
        if (masks) {
          [r, g, bl] = [channel(v, masks[0]), channel(v, masks[1]), channel(v, masks[2])];
          a = masks[3] ? channel(v, masks[3]) : 255;
        } else {
          [bl, g, r, a] = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
        }
        if (a) alphaSeen = true;
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = bl;
      px[o + 3] = a;
    }
  }
  // 32-bit bitmaps without alpha (all zero) are opaque.
  if (bpp === 32 && !masks && !alphaSeen) for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return { w, h, px };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(img: Rgba | null): { mime: string; data: Buffer } | null {
  if (!img) return null;
  const { w, h, px } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const data = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { mime: "image/png", data };
}
