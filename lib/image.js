/**
 * Format dispatch: sniff, dimension probe, luma rows and RGBA tiles.
 *
 * Supported decode: PNG (own codec), baseline JPEG (own codec).
 * Other containers (GIF/WebP/BMP) still report dimensions so the caller can
 * fall back to a blind split.
 */

import { decodePng, isPng, pngSize } from './png.js';
import { decodeJpeg, isJpeg, jpegSize, jpegTile } from './jpeg.js';

/** @typedef {{format:string,width:number,height:number,profiled:boolean,decodeError?:string}} ImageInfo */

function sniffOther(buf) {
    if (buf.length > 10 && buf.toString('latin1', 0, 4) === 'GIF8') {
        return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
        const kind = buf.toString('latin1', 12, 16);
        if (kind === 'VP8X') {
            const w = 1 + buf.readUIntLE(24, 3);
            const h = 1 + buf.readUIntLE(27, 3);
            return { format: 'webp', width: w, height: h };
        }
        if (kind === 'VP8 ') {
            return {
                format: 'webp',
                width: buf.readUInt16LE(26) & 0x3fff,
                height: buf.readUInt16LE(28) & 0x3fff,
            };
        }
        if (kind === 'VP8L') {
            const b0 = buf[21];
            const b1 = buf[22];
            const b2 = buf[23];
            const b3 = buf[24];
            const w = 1 + (((b1 & 0x3f) << 8) | b0);
            const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
            return { format: 'webp', width: w, height: h };
        }
        return { format: 'webp', width: 0, height: 0 };
    }
    if (buf.length > 26 && buf.toString('latin1', 0, 2) === 'BM') {
        return {
            format: 'bmp',
            width: Math.abs(buf.readInt32LE(18)),
            height: Math.abs(buf.readInt32LE(22)),
        };
    }
    return null;
}

/**
 * Cheap dimension probe that never decodes pixels.
 * @param {Buffer} buf
 * @returns {ImageInfo|null}
 */
export function probeImage(buf) {
    if (isPng(buf)) {
        const size = pngSize(buf);
        return size ? { format: 'png', ...size, profiled: true } : null;
    }
    if (isJpeg(buf)) {
        const size = jpegSize(buf);
        return size ? { format: 'jpeg', ...size, profiled: true } : null;
    }
    const other = sniffOther(buf);
    return other ? { ...other, profiled: false } : null;
}

/**
 * Decode an image for profiling and tiling.
 * @param {Buffer} buf
 * @returns {{
 *   format:string, width:number, height:number,
 *   rowLuma:(y:number)=>Uint8Array,
 *   tile:(x0:number,y0:number,w:number,h:number)=>Buffer,
 * }}
 */
export function decodeImage(buf) {
    if (isPng(buf)) {
        const { width, height, rgba } = decodePng(buf);
        const lumaRow = new Uint8Array(width);
        return {
            format: 'png',
            width,
            height,
            rowLuma(y) {
                const base = y * width * 4;
                for (let x = 0; x < width; x++) {
                    const o = base + x * 4;
                    const a = rgba[o + 3];
                    let r = rgba[o];
                    let g = rgba[o + 1];
                    let b = rgba[o + 2];
                    if (a !== 255) {
                        // Composite transparent pixels onto white: a screenshot with
                        // transparency should read like the page it was taken from.
                        const inv = 255 - a;
                        r = (r * a + 255 * inv) / 255;
                        g = (g * a + 255 * inv) / 255;
                        b = (b * a + 255 * inv) / 255;
                    }
                    lumaRow[x] = (r * 299 + g * 587 + b * 114) / 1000 | 0;
                }
                return lumaRow;
            },
            tile(x0, y0, w, h) {
                const out = Buffer.alloc(w * h * 4);
                for (let y = 0; y < h; y++) {
                    const from = ((y0 + y) * width + x0) * 4;
                    rgba.copy(out, y * w * 4, from, from + w * 4);
                }
                return out;
            },
        };
    }
    if (isJpeg(buf)) {
        const img = decodeJpeg(buf);
        const yPlane = img.planes[0];
        return {
            format: 'jpeg',
            width: img.width,
            height: img.height,
            rowLuma(y) {
                const start = y * yPlane.stride;
                return yPlane.data.subarray(start, start + img.width);
            },
            tile(x0, y0, w, h) {
                return jpegTile(img, x0, y0, w, h);
            },
        };
    }
    throw new Error('unsupported image format (PNG and baseline JPEG are decoded)');
}
