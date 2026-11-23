/**
 * PNG codec (decode + encode), zero external dependencies.
 *
 * Decode: non-interlaced and Adam7-interlaced PNGs of bit depth 1/2/4/8/16 with
 * colour types 0/2/3/4/6, palette and tRNS included. 16-bit samples keep their
 * high byte, sub-byte samples are scaled to 8 bit.
 * Encode: truecolour with alpha, adaptive per-row filters, zlib level 9.
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf) {
    return buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Read IHDR dimensions without decoding pixel data. */
export function pngSize(buf) {
    if (!isPng(buf) || buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
];

/**
 * Decode a PNG into RGBA.
 * @param {Buffer} buf encoded PNG bytes
 * @returns {{width:number, height:number, rgba:Buffer}}
 */
export function decodePng(buf) {
    if (!isPng(buf)) throw new Error('not a PNG');
    let pos = 8;
    let ihdr = null;
    let palette = null;
    let trns = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const length = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const dataStart = pos + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > buf.length) throw new Error('truncated PNG chunk ' + type);
        const chunkData = buf.subarray(dataStart, dataEnd);
        if (type === 'IHDR') {
            ihdr = {
                width: chunkData.readUInt32BE(0),
                height: chunkData.readUInt32BE(4),
                bitDepth: chunkData[8],
                colorType: chunkData[9],
                interlace: chunkData[12],
            };
        } else if (type === 'PLTE') {
            palette = chunkData;
        } else if (type === 'tRNS') {
            trns = chunkData;
        } else if (type === 'IDAT') {
            idat.push(chunkData);
        } else if (type === 'IEND') {
            break;
        }
        pos = dataEnd + 4; // skip CRC
    }
    if (!ihdr) throw new Error('PNG without IHDR');
    const { width, height, bitDepth, colorType, interlace } = ihdr;
    if (!(colorType in CHANNELS)) throw new Error('unsupported PNG colour type ' + colorType);
    if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error('unsupported PNG bit depth ' + bitDepth);
    if (colorType === 3 && !palette) throw new Error('palette PNG without PLTE');
    if (width <= 0 || height <= 0) throw new Error('empty PNG');
    if (!idat.length) throw new Error('PNG without IDAT');

    const channels = CHANNELS[colorType];
    const bitsPerPixel = channels * bitDepth;
    const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const rgba = Buffer.alloc(width * height * 4);
    const trnsColor = readTrns(trns, colorType);

    if (interlace === 0) {
        const stride = Math.ceil((width * bitsPerPixel) / 8);
        let offset = 0;
        let prev = null;
        for (let y = 0; y < height; y++) {
            if (offset + stride + 1 > raw.length) throw new Error('PNG pixel data too short');
            const filter = raw[offset++];
            const line = raw.subarray(offset, offset + stride);
            offset += stride;
            applyFilter(line, prev, stride, bpp, filter);
            writeScanline(rgba, width, height, 0, y, 1, line, bitDepth, colorType, channels, palette, trnsColor);
            prev = line;
        }
    } else {
        let offset = 0;
        for (const [x0, y0, dx, dy] of ADAM7) {
            const passW = Math.ceil((width - x0) / dx);
            const passH = Math.ceil((height - y0) / dy);
            if (passW <= 0 || passH <= 0) continue;
            const stride = Math.ceil((passW * bitsPerPixel) / 8);
            let prev = null;
            for (let y = 0; y < passH; y++) {
                if (offset + stride + 1 > raw.length) throw new Error('PNG pixel data too short');
                const filter = raw[offset++];
                const line = raw.subarray(offset, offset + stride);
                offset += stride;
                applyFilter(line, prev, stride, bpp, filter);
                writeScanline(rgba, width, height, x0, y0 + y * dy, dx, line, bitDepth, colorType, channels, palette, trnsColor);
                prev = line;
            }
        }
    }
    return { width, height, rgba };
}

function readTrns(trns, colorType) {
    if (!trns) return null;
    if (colorType === 3) return { palette: true, data: trns };
    if (colorType === 0 && trns.length >= 2) return { gray: trns.readUInt16BE(0) };
    if (colorType === 2 && trns.length >= 6) {
        return { r: trns.readUInt16BE(0), g: trns.readUInt16BE(2), b: trns.readUInt16BE(4) };
    }
    return null;
}

function applyFilter(line, prev, stride, bpp, filter) {
    switch (filter) {
        case 0:
            return;
        case 1:
            for (let i = bpp; i < stride; i++) line[i] = (line[i] + line[i - bpp]) & 0xff;
            return;
        case 2:
            if (prev) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
            return;
        case 3:
            for (let i = 0; i < stride; i++) {
                const left = i >= bpp ? line[i - bpp] : 0;
                const up = prev ? prev[i] : 0;
                line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
            }
            return;
        case 4:
            for (let i = 0; i < stride; i++) {
                const left = i >= bpp ? line[i - bpp] : 0;
                const up = prev ? prev[i] : 0;
                const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
                line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
            }
            return;
        default:
            throw new Error('unknown PNG filter ' + filter);
    }
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function sampleAt(line, index, bitDepth) {
    if (bitDepth === 8) return line[index];
    if (bitDepth === 16) return line[index * 2];
    const bitPos = index * bitDepth;
    const byte = line[bitPos >> 3];
    const shift = 8 - bitDepth - (bitPos & 7);
    return (byte >> shift) & ((1 << bitDepth) - 1);
}

function writeScanline(rgba, imgW, imgH, x0, y, dx, line, bitDepth, colorType, channels, palette, trnsColor) {
    const count = Math.ceil((imgW - x0) / dx);
    const scaleSubByte = 255 / ((1 << bitDepth) - 1);
    for (let i = 0; i < count; i++) {
        const x = x0 + i * dx;
        if (x >= imgW || y >= imgH) break;
        const out = (y * imgW + x) * 4;
        if (colorType === 3) {
            const idx = sampleAt(line, i, bitDepth);
            const p = idx * 3;
            rgba[out] = palette[p] || 0;
            rgba[out + 1] = palette[p + 1] || 0;
            rgba[out + 2] = palette[p + 2] || 0;
            rgba[out + 3] = trnsColor && trnsColor.palette && idx < trnsColor.data.length ? trnsColor.data[idx] : 255;
            continue;
        }
        if (colorType === 0) {
            const v = sampleAt(line, i, bitDepth);
            const g = bitDepth < 8 ? Math.round(v * scaleSubByte) : v;
            rgba[out] = g;
            rgba[out + 1] = g;
            rgba[out + 2] = g;
            rgba[out + 3] = trnsColor && trnsColor.gray === v ? 0 : 255;
            continue;
        }
        if (colorType === 4) {
            const v = sampleAt(line, i * 2, bitDepth);
            rgba[out] = v;
            rgba[out + 1] = v;
            rgba[out + 2] = v;
            rgba[out + 3] = sampleAt(line, i * 2 + 1, bitDepth);
            continue;
        }
        const r = sampleAt(line, i * channels, bitDepth);
        const g = sampleAt(line, i * channels + 1, bitDepth);
        const b = sampleAt(line, i * channels + 2, bitDepth);
        rgba[out] = r;
        rgba[out + 1] = g;
        rgba[out + 2] = b;
        if (colorType === 6) {
            rgba[out + 3] = sampleAt(line, i * channels + 3, bitDepth);
        } else {
            const seeThrough = trnsColor && trnsColor.r === r && trnsColor.g === g && trnsColor.b === b;
            rgba[out + 3] = seeThrough ? 0 : 255;
        }
    }
}

/**
 * Encode RGBA pixels as a PNG.
 * @param {Buffer|Uint8Array} rgba width*height*4 bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    const prev = Buffer.alloc(stride);
    const cur = Buffer.alloc(stride);
    const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
    const bpp = 4;
    for (let y = 0; y < height; y++) {
        rgba.copy(cur, 0, y * stride, y * stride + stride);
        let best = 0;
        let bestScore = Infinity;
        for (let f = 0; f < 5; f++) {
            const out = candidates[f];
            let score = 0;
            for (let i = 0; i < stride; i++) {
                const left = i >= bpp ? cur[i - bpp] : 0;
                const up = y > 0 ? prev[i] : 0;
                const upLeft = y > 0 && i >= bpp ? prev[i - bpp] : 0;
                let pred = 0;
                if (f === 1) pred = left;
                else if (f === 2) pred = up;
                else if (f === 3) pred = (left + up) >> 1;
                else if (f === 4) pred = paeth(left, up, upLeft);
                const v = (cur[i] - pred) & 0xff;
                out[i] = v;
                score += v < 128 ? v : 256 - v;
            }
            if (score < bestScore) {
                bestScore = score;
                best = f;
            }
        }
        const base = y * (stride + 1);
        raw[base] = best;
        candidates[best].copy(raw, base + 1);
        cur.copy(prev);
    }

    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdrBytes(width, height)),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function ihdrBytes(width, height) {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(width, 0);
    b.writeUInt32BE(height, 4);
    b[8] = 8; // bit depth
    b[9] = 6; // truecolour + alpha
    return b;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
