// Horizontal contact strips (shot-02s | shot-08s | shot-20s) so the jury reads one image per anchor.
import { readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng, type DecodedImage } from "./image-metrics.js";

const BORDER = 2;
const BORDER_RGB = [17, 17, 17] as const;

/** Box-filter resample (area average when shrinking, nearest when growing). */
export function resizeBox(src: DecodedImage, w: number, h: number): DecodedImage {
  const out = new Uint8Array(w * h * 4);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let oy = 0; oy < h; oy++) {
    const y0 = Math.floor(oy * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((oy + 1) * sy)));
    for (let ox = 0; ox < w; ox++) {
      const x0 = Math.floor(ox * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((ox + 1) * sx)));
      const acc = [0, 0, 0, 0];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * src.width + x) * 4;
          for (let c = 0; c < 4; c++) acc[c]! += src.data[i + c]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (oy * w + ox) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c]! / n);
    }
  }
  return { width: w, height: h, data: out };
}

/** Tiles `pngPaths` left to right at tileWidth x tileHeight with a 2 px dark border; returns outPath. */
export async function buildHorizontalStrip(pngPaths: string[], outPath: string, tileWidth = 426, tileHeight = 240): Promise<string> {
  if (!pngPaths.length) throw new Error("buildHorizontalStrip needs at least one PNG");
  const width = pngPaths.length * (tileWidth + BORDER) + BORDER;
  const height = tileHeight + 2 * BORDER;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BORDER_RGB[0];
    data[i + 1] = BORDER_RGB[1];
    data[i + 2] = BORDER_RGB[2];
    data[i + 3] = 255;
  }
  pngPaths.forEach((p, n) => {
    const tile = resizeBox(decodePng(readFileSync(p)), tileWidth, tileHeight);
    const left = BORDER + n * (tileWidth + BORDER);
    for (let y = 0; y < tileHeight; y++) {
      const row = tile.data.subarray(y * tileWidth * 4, (y + 1) * tileWidth * 4);
      data.set(row, ((y + BORDER) * width + left) * 4);
    }
  });
  writeFileSync(outPath, encodePng({ width, height, data }));
  return outPath;
}
