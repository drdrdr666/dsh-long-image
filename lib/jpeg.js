/**
 * Baseline JPEG decoder (SOF0/SOF1), zero external dependencies.
 *
 * Scope: 8-bit Huffman-coded sequential JPEG, any chroma subsampling, restart
 * intervals, grayscale / YCbCr / CMYK. Progressive (SOF2), arithmetic-coded and
 * 12-bit files are rejected with a typed error so the caller can fall back.
 *
 * Output is kept planar: the luma plane is used for the ink profile, and colour
 * conversion happens per emitted tile, so a very tall image never allocates a
 * full RGB copy.
 */

const ZIGZAG = new Int32Array([
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
]);

export class JpegUnsupportedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'JpegUnsupportedError';
        this.code = 'JPEG_UNSUPPORTED';
    }
}

export function isJpeg(buf) {
    return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}

/** Read dimensions from the frame header without decoding entropy data. */
export function jpegSize(buf) {
    let pos = 2;
    while (pos + 4 <= buf.length) {
        if (buf[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = buf[pos + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            pos += 2;
            continue;
        }
        const length = buf.readUInt16BE(pos + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame && pos + 9 <= buf.length) {
            return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
        }
        pos += 2 + length;
    }
    return null;
}

class BitReader {
    constructor(data, start, end) {
        this.data = data;
        this.pos = start;
        this.end = end;
        this.buffer = 0;
        this.count = 0;
        this.hitMarker = 0;
    }

    fill() {
        while (this.count <= 24) {
            let byte = 0;
            if (this.pos < this.end) {
                byte = this.data[this.pos++];
                if (byte === 0xff) {
                    let next = this.pos < this.end ? this.data[this.pos] : 0xd9;
                    while (next === 0xff && this.pos < this.end) {
                        this.pos++;
                        next = this.pos < this.end ? this.data[this.pos] : 0xd9;
                    }
                    if (next === 0x00) {
                        this.pos++;
                    } else {
                        // A marker starts here: do not consume it, feed zero bits.
                        this.pos--;
                        this.hitMarker = next;
                        byte = 0;
                    }
                }
            }
            this.buffer = (this.buffer << 8) | byte;
            this.count += 8;
        }
    }

    bits(n) {
        if (n === 0) return 0;
        if (this.count < n) this.fill();
        this.count -= n;
        return (this.buffer >>> this.count) & ((1 << n) - 1);
    }

    bit() {
        if (this.count < 1) this.fill();
        this.count -= 1;
        return (this.buffer >>> this.count) & 1;
    }

    /** Discard bit-buffer remainder and consume one RSTn marker if present. */
    restart() {
        this.count = 0;
        this.buffer = 0;
        while (this.pos < this.end && this.data[this.pos] !== 0xff) this.pos++;
        while (this.pos < this.end && this.data[this.pos] === 0xff) this.pos++;
        if (this.pos < this.end) {
            const marker = this.data[this.pos];
            if (marker >= 0xd0 && marker <= 0xd7) this.pos++;
        }
        this.hitMarker = 0;
    }
}

function buildHuffman(counts, symbols) {
    const maxcode = new Int32Array(18).fill(-1);
    const mincode = new Int32Array(17);
    const valptr = new Int32Array(17);
    let code = 0;
    let k = 0;
    for (let length = 1; length <= 16; length++) {
        const count = counts[length];
        if (count === 0) {
            maxcode[length] = -1;
        } else {
            valptr[length] = k;
            mincode[length] = code;
            code += count;
            k += count;
            maxcode[length] = code - 1;
        }
        // 每个码长结束时都必须左移一位，长度缺项时也一样。
        // 早期版本在 count === 0 的分支里 continue 掉了这次移位，导致其后所有
        // 码字整体错位：码仍能"解出来"，但系数全错，图像退化成 8 像素周期的灰噪点。
        code <<= 1;
    }
    maxcode[17] = Number.MAX_SAFE_INTEGER;
    return { maxcode, mincode, valptr, symbols };
}

function decodeHuffman(reader, table, maxcode, mincode, valptr, symbols) {
    void table;
    let code = 0;
    for (let length = 1; length <= 16; length++) {
        code = (code << 1) | reader.bit();
        if (code <= maxcode[length]) {
            return symbols[valptr[length] + code - mincode[length]];
        }
    }
    throw new Error('invalid JPEG Huffman code');
}

const extend = (value, bits) => (value < 1 << (bits - 1) ? value - (1 << bits) + 1 : value);

function makeIdct() {
    // Basis matrix: M[u][x] = c(u)/2 * cos((2x+1)uπ/16)
    const M = new Float64Array(64);
    for (let u = 0; u < 8; u++) {
        const c = u === 0 ? Math.SQRT1_2 : 1;
        for (let x = 0; x < 8; x++) {
            M[u * 8 + x] = (c / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
        }
    }
    const block = new Float64Array(64);
    const tmp = new Float64Array(64);
    return function idct(coeffs) {
        let nonzero = 0;
        for (let i = 1; i < 64; i++) if (coeffs[i] !== 0) { nonzero++; break; }
        if (nonzero === 0) {
            const v = clamp(coeffs[0] / 8 + 128);
            for (let i = 0; i < 64; i++) block[i] = v;
            return block;
        }
        for (let v = 0; v < 8; v++) {
            for (let x = 0; x < 8; x++) {
                let sum = 0;
                for (let u = 0; u < 8; u++) {
                    const c = coeffs[v * 8 + u];
                    if (c !== 0) sum += c * M[u * 8 + x];
                }
                tmp[v * 8 + x] = sum;
            }
        }
        for (let x = 0; x < 8; x++) {
            for (let y = 0; y < 8; y++) {
                let sum = 0;
                for (let v = 0; v < 8; v++) {
                    const c = tmp[v * 8 + x];
                    if (c !== 0) sum += c * M[v * 8 + y];
                }
                block[y * 8 + x] = clamp(sum + 128);
            }
        }
        return block;
    };
}

function clamp(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

/**
 * Decode a baseline JPEG.
 * @param {Buffer} buf
 * @returns {{width:number, height:number, planes:Array<{data:Uint8Array,stride:number,w:number,h:number}>, components:number, maxH:number, maxV:number}}
 */
export function decodeJpeg(buf) {
    if (!isJpeg(buf)) throw new Error('not a JPEG');
    const quant = [];
    const dcTables = [];
    const acTables = [];
    let frame = null;
    let restartInterval = 0;
    let adobeTransform = -1;
    const idct = makeIdct();

    let pos = 2;
    while (pos + 4 <= buf.length) {
        if (buf[pos] !== 0xff) {
            pos++;
            continue;
        }
        const marker = buf[pos + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            pos += 2;
            continue;
        }
        if (marker === 0xd9) break;
        const length = buf.readUInt16BE(pos + 2);
        const segStart = pos + 4;
        const segEnd = pos + 2 + length;
        if (segEnd > buf.length) throw new Error('truncated JPEG segment');

        if (marker === 0xdb) {
            let p = segStart;
            while (p < segEnd) {
                const pq = buf[p] >> 4;
                const tq = buf[p] & 15;
                p++;
                const table = new Int32Array(64);
                for (let i = 0; i < 64; i++) {
                    if (pq === 0) {
                        table[ZIGZAG[i]] = buf[p++];
                    } else {
                        table[ZIGZAG[i]] = buf.readUInt16BE(p);
                        p += 2;
                    }
                }
                quant[tq] = table;
            }
        } else if (marker === 0xc4) {
            let p = segStart;
            while (p < segEnd) {
                const tc = buf[p] >> 4;
                const th = buf[p] & 15;
                p++;
                const counts = new Int32Array(17);
                let total = 0;
                for (let i = 1; i <= 16; i++) {
                    counts[i] = buf[p++];
                    total += counts[i];
                }
                const symbols = new Uint8Array(total);
                for (let i = 0; i < total; i++) symbols[i] = buf[p++];
                const table = buildHuffman(counts, symbols);
                if (tc === 0) dcTables[th] = table;
                else acTables[th] = table;
            }
        } else if (marker === 0xdd) {
            restartInterval = buf.readUInt16BE(segStart);
        } else if (marker === 0xee && length >= 12) {
            if (buf.toString('latin1', segStart, segStart + 5) === 'Adobe') {
                adobeTransform = buf[segStart + 11];
            }
        } else if (marker === 0xc0 || marker === 0xc1) {
            const precision = buf[segStart];
            if (precision !== 8) throw new JpegUnsupportedError('only 8-bit JPEG is supported (got ' + precision + ' bit)');
            const height = buf.readUInt16BE(segStart + 1);
            const width = buf.readUInt16BE(segStart + 3);
            const count = buf[segStart + 5];
            const comps = [];
            let maxH = 1;
            let maxV = 1;
            let p = segStart + 6;
            for (let i = 0; i < count; i++) {
                const id = buf[p];
                const h = buf[p + 1] >> 4;
                const v = buf[p + 1] & 15;
                const tq = buf[p + 2];
                comps.push({ id, h, v, tq, dc: 0 });
                maxH = Math.max(maxH, h);
                maxV = Math.max(maxV, v);
                p += 3;
            }
            frame = { width, height, comps, maxH, maxV, progressive: false };
        } else if (marker === 0xc2) {
            throw new JpegUnsupportedError('progressive JPEG is not supported');
        } else if (marker === 0xc3 || marker === 0xc5 || marker === 0xc6 || marker === 0xc7
            || marker === 0xc9 || marker === 0xca || marker === 0xcb || marker === 0xcd || marker === 0xce || marker === 0xcf) {
            throw new JpegUnsupportedError('lossless / arithmetic / hierarchical JPEG is not supported');
        } else if (marker === 0xda) {
            if (!frame) throw new Error('JPEG scan before frame header');
            const count = buf[segStart];
            const scanComps = [];
            let p = segStart + 1;
            for (let i = 0; i < count; i++) {
                const id = buf[p];
                const tables = buf[p + 1];
                p += 2;
                const comp = frame.comps.find((c) => c.id === id);
                if (!comp) throw new Error('JPEG scan references unknown component ' + id);
                scanComps.push({ comp, dcTable: tables >> 4, acTable: tables & 15, pred: 0 });
            }
            p += 2; // Ss, Se
            p += 1; // Ah/Al
            // 熵编码数据一直延伸到下一个 marker（通常是 EOI），不是 SOS 段结束。
            // 早期版本传的是 segEnd，位读取器一开局就越界返回 0 比特，
            // 结果每个块都解出同样的假系数，图像退化成 8 像素周期的灰噪点。
            decodeScan(buf, p, buf.length, frame, scanComps, quant, dcTables, acTables, restartInterval, idct);
            break;
        }
        pos = segEnd;
    }
    if (!frame) throw new Error('JPEG without frame header');

    const planes = frame.comps.map((comp) => {
        const w = Math.ceil((frame.width * comp.h) / frame.maxH);
        const h = Math.ceil((frame.height * comp.v) / frame.maxV);
        const blocksW = Math.ceil(w / 8);
        const blocksH = Math.ceil(h / 8);
        return { data: comp.plane, stride: blocksW * 8, w, h, blocksW, blocksH, hf: comp.h, vf: comp.v };
    });

    return {
        width: frame.width,
        height: frame.height,
        planes,
        components: frame.comps.length,
        maxH: frame.maxH,
        maxV: frame.maxV,
        adobeTransform,
    };
}

function decodeScan(buf, start, end, frame, scanComps, quant, dcTables, acTables, restartInterval, idct) {
    const { width, height, maxH, maxV } = frame;
    const mcuW = 8 * maxH;
    const mcuH = 8 * maxV;
    const mcuCols = Math.ceil(width / mcuW);
    const mcuRows = Math.ceil(height / mcuH);

    for (const sc of scanComps) {
        const comp = sc.comp;
        const w = Math.ceil((width * comp.h) / maxH);
        const h = Math.ceil((height * comp.v) / maxV);
        const blocksW = Math.ceil(w / 8);
        const blocksH = Math.ceil(h / 8);
        comp.plane = new Uint8Array(blocksW * 8 * (blocksH * 8));
        comp.blocksW = blocksW;
        comp.blocksH = blocksH;
        comp.stride = blocksW * 8;
        sc.qt = quant[comp.tq];
        if (!sc.qt) throw new Error('JPEG component without quantisation table');
        sc.dcHuff = dcTables[sc.dcTable];
        sc.acHuff = acTables[sc.acTable];
        if (!sc.dcHuff || !sc.acHuff) throw new Error('JPEG scan without Huffman table');
    }

    const reader = new BitReader(buf, start, end);
    const coeffs = new Int32Array(64);
    let mcuSinceRestart = 0;

    for (let my = 0; my < mcuRows; my++) {
        for (let mx = 0; mx < mcuCols; mx++) {
            if (restartInterval > 0 && mcuSinceRestart === restartInterval) {
                reader.restart();
                for (const sc of scanComps) sc.pred = 0;
                mcuSinceRestart = 0;
            }
            for (const sc of scanComps) {
                const comp = sc.comp;
                for (let v = 0; v < comp.v; v++) {
                    for (let h = 0; h < comp.h; h++) {
                        const blockX = mx * comp.h + h;
                        const blockY = my * comp.v + v;
                        if (blockX >= comp.blocksW || blockY >= comp.blocksH) {
                            // Outside the coded area: skip its coefficients.
                            skipBlock(reader, sc);
                            continue;
                        }
                        coeffs.fill(0);
                        const t = sc.dcHuff;
                        const dcLen = decodeHuffman(reader, t, t.maxcode, t.mincode, t.valptr, t.symbols);
                        let diff = 0;
                        if (dcLen > 0) diff = extend(reader.bits(dcLen), dcLen);
                        sc.pred += diff;
                        coeffs[0] = sc.pred * sc.qt[0];
                        let k = 1;
                        while (k < 64) {
                            const at = sc.acHuff;
                            const rs = decodeHuffman(reader, at, at.maxcode, at.mincode, at.valptr, at.symbols);
                            const run = rs >> 4;
                            const size = rs & 15;
                            if (size === 0) {
                                if (run === 15) {
                                    k += 16;
                                    continue;
                                }
                                break;
                            }
                            k += run;
                            if (k > 63) break;
                            const value = extend(reader.bits(size), size);
                            coeffs[ZIGZAG[k]] = value * sc.qt[ZIGZAG[k]];
                            k++;
                        }
                        const pixels = idct(coeffs);
                        const plane = comp.plane;
                        const stride = comp.stride;
                        const base = blockY * 8 * stride + blockX * 8;
                        for (let y = 0; y < 8; y++) {
                            const row = base + y * stride;
                            const src = y * 8;
                            for (let x = 0; x < 8; x++) plane[row + x] = pixels[src + x];
                        }
                    }
                }
            }
            mcuSinceRestart++;
        }
    }
}

function skipBlock(reader, sc) {
    const t = sc.dcHuff;
    const dcLen = decodeHuffman(reader, t, t.maxcode, t.mincode, t.valptr, t.symbols);
    if (dcLen > 0) reader.bits(dcLen);
    let k = 1;
    while (k < 64) {
        const at = sc.acHuff;
        const rs = decodeHuffman(reader, at, at.maxcode, at.mincode, at.valptr, at.symbols);
        const run = rs >> 4;
        const size = rs & 15;
        if (size === 0) {
            if (run === 15) {
                k += 16;
                continue;
            }
            break;
        }
        k += run;
        if (k > 63) break;
        reader.bits(size);
        k++;
    }
}

/**
 * One RGBA tile from a decoded JPEG.
 * @param {ReturnType<typeof decodeJpeg>} img
 * @param {number} x0
 * @param {number} y0
 * @param {number} w
 * @param {number} h
 * @returns {Buffer}
 */
export function jpegTile(img, x0, y0, w, h) {
    const out = Buffer.alloc(w * h * 4);
    const { planes, maxH, maxV, components, adobeTransform } = img;
    const yP = planes[0];
    const c1 = planes[1];
    const c2 = planes[2];
    const c3 = planes[3];
    const sample = (plane, x, y) => {
        const px = Math.min(plane.w - 1, Math.floor((x * plane.hf) / maxH));
        const py = Math.min(plane.h - 1, Math.floor((y * plane.vf) / maxV));
        return plane.data[py * plane.stride + px];
    };
    for (let y = 0; y < h; y++) {
        const sy = y0 + y;
        for (let x = 0; x < w; x++) {
            const sx = x0 + x;
            const o = (y * w + x) * 4;
            if (components === 1) {
                const g = sample(yP, sx, sy);
                out[o] = g;
                out[o + 1] = g;
                out[o + 2] = g;
                out[o + 3] = 255;
                continue;
            }
            if (components === 3) {
                const yy = sample(yP, sx, sy);
                const cb = sample(c1, sx, sy) - 128;
                const cr = sample(c2, sx, sy) - 128;
                if (adobeTransform === 0) {
                    out[o] = yy;
                    out[o + 1] = sample(c1, sx, sy);
                    out[o + 2] = sample(c2, sx, sy);
                } else {
                    out[o] = clampRgb(yy + 1.402 * cr);
                    out[o + 1] = clampRgb(yy - 0.344136 * cb - 0.714136 * cr);
                    out[o + 2] = clampRgb(yy + 1.772 * cb);
                }
                out[o + 3] = 255;
                continue;
            }
            // CMYK / YCCK: naive conversion, sufficient for profiling and display.
            let c = sample(yP, sx, sy);
            let m = sample(c1, sx, sy);
            let yel = sample(c2, sx, sy);
            let k = sample(c3, sx, sy);
            if (adobeTransform === 2) {
                const cc = 255 - c;
                const mm = 255 - m;
                const yy = 255 - yel;
                c = 255 - clampRgb(cc + 1.402 * (yy - 128));
                m = 255 - clampRgb(mm - 0.344136 * (yy - 128));
                yel = k;
            }
            out[o] = clampRgb((255 - c) * (255 - k) / 255);
            out[o + 1] = clampRgb((255 - m) * (255 - k) / 255);
            out[o + 2] = clampRgb((255 - yel) * (255 - k) / 255);
            out[o + 3] = 255;
        }
    }
    return out;
}

function clampRgb(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
