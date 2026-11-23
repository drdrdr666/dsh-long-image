/**
 * Planning layer: load bytes, decode, profile, plan cuts, describe the result.
 * Kept free of harness imports so it can be unit-tested with plain node.
 */

import { readFileSync } from 'node:fs';
import { decodeImage, probeImage } from './image.js';
import { inkProfile, quietShare } from './profile.js';
import { planTiles } from './tiler.js';
import { DEFAULTS, maxTileHeight } from './geometry.js';

export function loadBuffer(file, limits = DEFAULTS) {
    const buf = readFileSync(file);
    if (buf.length > limits.maxFileBytes) {
        throw new Error(`图片有 ${(buf.length / 1048576).toFixed(1)}MB，超过 ${limits.maxFileBytes / 1048576}MB 上限`);
    }
    return buf;
}

/** Blind plan used when the container cannot be decoded (WebP/GIF/progressive JPEG). */
export function blindPlan(width, height, tileHeight, parts) {
    const count = Math.max(1, parts || Math.ceil(height / tileHeight));
    const step = height / count;
    const tiles = [];
    for (let i = 0; i < count; i++) {
        const y0 = Math.round(i * step);
        const y1 = i === count - 1 ? height : Math.round((i + 1) * step);
        tiles.push({ index: i + 1, y0, y1, coreY0: y0, coreY1: y1, cutBefore: null, cutAfter: null });
    }
    return {
        width,
        height,
        parts: tiles.length,
        tiles,
        boundaries: [],
        softCuts: [],
        safeTileHeight: tileHeight,
        clean: false,
        warnings: ['该格式无法做墨迹分析，按等高盲切；转成 PNG 后重跑可以保证切口落在空白行'],
    };
}

/**
 * Decode, profile and plan one image file.
 * @param {string} file absolute path
 * @param {{parts?:number, inkThreshold?:number, quietRatio?:number, softOverlap?:number, geometry?:object}} [options]
 */
export function plan(file, options = {}) {
    const geometry = options.geometry || {};
    const buf = loadBuffer(file, { ...DEFAULTS, ...geometry });
    const probe = probeImage(buf);
    if (!probe) throw new Error('无法识别的图片格式（支持 PNG / JPEG）');
    const limits = { ...DEFAULTS, ...geometry };
    if (probe.width * probe.height > limits.maxPixels) {
        throw new Error(`图片 ${probe.width}×${probe.height} 超过 ${limits.maxPixels / 1e6}M 像素上限，先缩小或分区域读`);
    }
    const tileHeight = maxTileHeight(probe.width, geometry);
    let img = null;
    let decodeError = null;
    try {
        img = decodeImage(buf);
    } catch (error) {
        decodeError = String((error && error.message) || error);
    }
    if (!img) {
        const blind = blindPlan(probe.width, probe.height, tileHeight, options.parts);
        blind.format = probe.format;
        blind.decodeError = decodeError;
        blind.quietShare = 0;
        return blind;
    }
    const profile = inkProfile(img, {
        inkThreshold: options.inkThreshold,
        quietRatio: options.quietRatio,
    });
    const result = planTiles({
        profile,
        maxTileHeight: tileHeight,
        partsHint: options.parts,
        softOverlap: options.softOverlap ?? DEFAULTS.softOverlap,
    });
    result.format = img.format;
    result.quietShare = quietShare(profile);
    result.quietThreshold = profile.quietThreshold;
    result.profile = profile;
    result.img = img;
    return result;
}

/** Human/agent-readable plan summary. */
export function describe(result, attached) {
    const lines = [];
    const marks = new Set(attached.map((t) => t.index));
    lines.push(
        `长图切片：${result.width}×${result.height} ${result.format} → ${result.parts} 片`
        + `（模型按 1:1 像素读取，单片高度上限 ${result.safeTileHeight}px）`,
    );
    if (result.boundaries && result.boundaries.length) {
        const clean = result.boundaries.filter((b) => b.kind === 'gap').length;
        lines.push(`切口 ${clean}/${result.boundaries.length} 落在空白行：文字零截断`
            + `；空白行占比 ${((result.quietShare || 0) * 100).toFixed(1)}%（判定阈值 ≤${result.quietThreshold} 个墨点）`);
    }
    lines.push(result.tiles.map((t) => {
        const mark = marks.has(t.index) ? '★' : ' ';
        return `${mark}#${t.index} y=${String(t.y0).padStart(6)}–${String(t.y1).padEnd(6)} 高 ${t.y1 - t.y0}`;
    }).join('\n'));
    if (attached.length) {
        lines.push(`本次附图：#${attached[0].index}–#${attached[attached.length - 1].index}`
            + `（共 ${attached.length} 张，顺序即阅读顺序）`);
    }
    if (result.warnings && result.warnings.length) {
        for (const warn of result.warnings) lines.push('⚠ ' + warn);
    }
    if (result.decodeError) lines.push('解码失败原因：' + result.decodeError);
    const lastAttached = attached.length ? attached[attached.length - 1].index : 0;
    if (lastAttached > 0 && lastAttached < result.parts) {
        lines.push(`其余分片用 long_see(path, from=${lastAttached + 1}) 继续读`);
    }
    lines.push('需要放大某一段：long_crop(path, y0, y1) 以 1:1 原像素再取一次');
    return lines.join('\n');
}
