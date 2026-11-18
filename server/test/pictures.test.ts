import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { browserPicture } from "../src/pictures.js";

/** A 2×2 24-bit BMP: red, green / blue, white (rows stored bottom-up). */
function bmp(): Buffer {
  const row = (a: number[], b: number[]) => Buffer.from([...a, ...b, 0, 0]); // 6 bytes + 2 padding
  const bits = Buffer.concat([row([255, 0, 0], [255, 255, 255]), row([0, 0, 255], [0, 255, 0])]); // BGR: blue, white / red, green
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(2, 4);
  info.writeInt32LE(2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  const head = Buffer.alloc(14);
  head.write("BM", 0, "latin1");
  head.writeUInt32LE(14 + 40 + bits.length, 2);
  head.writeUInt32LE(54, 10);
  return Buffer.concat([head, info, bits]);
}

/** The pixels of a PNG this module wrote (RGBA, filter 0). */
function pixels(png: Buffer) {
  const w = png.readUInt32BE(16);
  const idat = png.indexOf("IDAT");
  const len = png.readUInt32BE(idat - 4);
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + len));
  const out: number[][] = [];
  for (let y = 0; y * (w * 4 + 1) < raw.length; y++) for (let x = 0; x < w; x++) out.push([...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)]);
  return out;
}

describe("pictures from Access designs", () => {
  it("passes browser formats through and turns a BMP into a PNG", () => {
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    expect(browserPicture(png)).toEqual({ mime: "image/png", data: png });
    const r = browserPicture(bmp())!;
    expect(r.mime).toBe("image/png");
    expect(pixels(r.data)).toEqual([
      [255, 0, 0, 255], [0, 255, 0, 255],
      [0, 0, 255, 255], [255, 255, 255, 255],
    ]);
  });

  it("finds the bitmap an EMF metafile draws (how Access stores a logo)", () => {
    const dib = bmp().subarray(14); // BITMAPINFOHEADER + bits
    const rec = Buffer.alloc(80 + dib.length);
    rec.writeUInt32LE(81, 0); // EMR_STRETCHDIBITS
    rec.writeUInt32LE(rec.length, 4);
    rec.writeUInt32LE(80, 48); // offBmiSrc
    rec.writeUInt32LE(40, 52); // cbBmiSrc
    rec.writeUInt32LE(120, 56); // offBitsSrc
    rec.writeUInt32LE(dib.length - 40, 60);
    dib.copy(rec, 80);
    const header = Buffer.alloc(88);
    header.writeUInt32LE(1, 0);
    header.writeUInt32LE(88, 4);
    header.write(" EMF", 40, "latin1");
    const eof = Buffer.alloc(20);
    eof.writeUInt32LE(14, 0);
    eof.writeUInt32LE(20, 4);
    const emf = Buffer.concat([Buffer.alloc(8), header, rec, eof]); // Access puts a small header first
    const r = browserPicture(emf)!;
    expect(r.mime).toBe("image/png");
    expect(pixels(r.data)[0]).toEqual([255, 0, 0, 255]);
    expect(browserPicture(Buffer.from("not a picture"))).toBeNull();
  });
});
