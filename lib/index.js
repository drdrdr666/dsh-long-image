/**
 * dsh-long-image — read very tall images without losing a single text line.
 *
 *   long_see   cut a long image into vision-model-sized parts on blank rows and
 *              attach every part in reading order
 *   long_crop  attach one exact pixel region at 1:1 for zoom reading
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { describe, loadBuffer, plan } from './plan.js';
import { DEFAULTS, maxTileHeight } from './geometry.js';
import { decodeImage } from './image.js';
import { encodePng } from './png.js';

export const name = 'dsh-long-image';

export const inject = ['tools'];

const OUTPUT = {
    schema: { type: 'json' },
    render(_args, value) {
        const blocks = [{ type: 'text', text: String((value && value.text) || '') }];
        if (value && Array.isArray(value.images)) {
            for (const im of value.images) blocks.push({ type: 'image', attachment: im });
        }
        return blocks;
    },
};

function clampIndex(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

function baseDir(ctx, exec) {
    try {
        if (exec && exec.agent && exec.agent.session) {
            const wd = ctx.get('workingDirectory');
            const dir = wd && typeof wd.get === 'function' ? wd.get(exec.agent.session) : undefined;
            if (dir) return dir;
        }
    } catch { /* fall through to the process directory */ }
    return process.cwd();
}

function resolveImagePath(ctx, exec, input) {
    let p = String(input || '').trim();
    if (!p) throw new Error('缺少 path');
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7)).replace(/^\/([A-Za-z]:)/, '$1');
    if (/^~[\\/]/.test(p)) p = path.join(process.env.USERPROFILE || process.env.HOME || '', p.slice(2));
    return path.isAbsolute(p) ? p : path.resolve(baseDir(ctx, exec), p);
}

function encodeTiles(result, selection) {
    return selection.map((tile) => {
        const height = tile.y1 - tile.y0;
        const rgba = result.img.tile(0, tile.y0, result.width, height);
        const png = encodePng(rgba, result.width, height);
        return { data: png, mediaType: 'image/png', name: `long-image-${tile.index}-of-${result.parts}.png`, bytes: png.length };
    });
}

export function apply(ctx) {
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'long_see',
        description:
            'Read a very tall image (long screenshot, chat log, full web page) in one call: cuts it into a few '
            + 'parts on blank rows so no text line is split, keeps every part at the resolution the vision model '
            + 'resolves 1:1, and attaches them in reading order. Prefer it over read_image when height is much '
            + 'larger than width.',
        parameters: {
            path: { type: 'string', description: 'Image path: absolute, or relative to the session working directory.' },
            parts: {
                type: 'number',
                description: 'How many parts to cut into. Omit for the automatic plan: as few parts as the model can still read at 1:1.',
            },
            from: { type: 'number', description: 'First part index to attach, 1-based. Omit to start at part 1.' },
            to: { type: 'number', description: 'Last part index to attach, inclusive. Omit to attach all remaining parts (capped per call).' },
            dryRun: { type: 'boolean', description: 'Return the cut plan only, with no image attachments.' },
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        timeoutMs: 120000,
        async execute(args, exec) {
            try {
                const file = resolveImagePath(ctx, exec, args && args.path);
                const result = plan(file, { parts: args && args.parts });
                const from = args && args.from !== undefined ? clampIndex(args.from, 1, result.parts) : 1;
                const to = args && args.to !== undefined ? clampIndex(args.to, from, result.parts) : result.parts;
                if (args && args.dryRun) {
                    return { text: describe(result, []) + '\n（dryRun：未附图）' };
                }
                const wanted = result.tiles.filter((t) => t.index >= from && t.index <= to);
                const selection = wanted.slice(0, DEFAULTS.maxAttachPerCall);
                if (!result.img) {
                    return {
                        text: describe(result, selection) + '\n'
                            + '该格式只能给出切片计划，不能附图：'
                            + (result.decodeError || '解码不可用')
                            + '。转成 PNG 或基线 JPEG 再试。',
                    };
                }
                const attachments = ctx.get('attachments');
                if (!attachments || typeof attachments.saveImages !== 'function') {
                    return { text: describe(result, selection) + '\n宿主没有 attachments 服务，无法附图' };
                }
                const imgs = encodeTiles(result, selection);
                const refs = await attachments.saveImages(
                    imgs.map((im) => ({ data: im.data, mediaType: 'image/png', name: im.name })),
                );
                const totalBytes = refs.reduce((sum, ref) => sum + (ref.bytes || 0), 0);
                const limit = attachments.imageLimits || {};
                const lines = [describe(result, selection)];
                lines.push(`附图总字节 ${(totalBytes / 1024).toFixed(0)}KB`
                    + (limit.maxMessageImageBytes && totalBytes > limit.maxMessageImageBytes * 0.5
                        ? '（偏大，必要时用 from/to 分批读）'
                        : ''));
                if (selection.length < wanted.length) {
                    lines.push(`本次只附前 ${selection.length} 张，剩余用 from=${selection[selection.length - 1].index + 1} 继续`);
                }
                // 必须回传完整附件引用（attachmentId + mediaType/width/height/bytes/name）。
                // 只给 attachmentId 会让宿主在下次请求时解析不出图片元数据，
                // 错误被上层包成 "DeepSeek Messages transport failed"，整个会话从此发不出消息。
                return { text: lines.join('\n'), images: refs.map((ref) => ({ ...ref })) };
            } catch (error) {
                return { text: 'long_see 失败：' + String((error && error.message) || error) };
            }
        },
    })), 'dsh-long-image: long_see');

    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'long_crop',
        description:
            'Attach one exact pixel region of an image at 1:1 — for zoom reading a dense area, or a wide image '
            + 'column by column. A region taller than the model resolves is cut on blank rows like long_see.',
        parameters: {
            path: { type: 'string', description: 'Image path: absolute, or relative to the session working directory.' },
            y0: { type: 'number', description: 'Top row of the region in source pixels, 0-based.' },
            y1: { type: 'number', description: 'Bottom row, exclusive.' },
            x0: { type: 'number', description: 'Left column, defaults to 0.' },
            x1: { type: 'number', description: 'Right column, exclusive, defaults to the image width.' },
        },
        output: OUTPUT,
        isConcurrencySafe: () => true,
        timeoutMs: 120000,
        async execute(args, exec) {
            try {
                const file = resolveImagePath(ctx, exec, args && args.path);
                const img = decodeImage(loadBuffer(file));
                const x0 = args && args.x0 !== undefined ? clampIndex(args.x0, 0, img.width - 1) : 0;
                const x1 = args && args.x1 !== undefined ? clampIndex(args.x1, x0 + 1, img.width) : img.width;
                const y0 = args && args.y0 !== undefined ? clampIndex(args.y0, 0, img.height - 1) : 0;
                const y1 = args && args.y1 !== undefined ? clampIndex(args.y1, y0 + 1, img.height) : img.height;
                const width = x1 - x0;
                const regionHeight = y1 - y0;
                const tileHeight = maxTileHeight(width);
                const count = Math.max(1, Math.ceil(regionHeight / tileHeight));
                const step = Math.ceil(regionHeight / count);
                const pieces = [];
                for (let i = 0; i < count; i++) {
                    const top = y0 + i * step;
                    const bottom = i === count - 1 ? y1 : Math.min(y1, y0 + (i + 1) * step);
                    if (bottom <= top) continue;
                    pieces.push({ top, bottom, png: encodePng(img.tile(x0, top, width, bottom - top), width, bottom - top) });
                }
                const attachments = ctx.get('attachments');
                if (!attachments || typeof attachments.saveImages !== 'function') {
                    return { text: '宿主没有 attachments 服务，无法附图' };
                }
                const refs = await attachments.saveImages(pieces.map((piece, i) => ({
                    data: piece.png,
                    mediaType: 'image/png',
                    name: `long-crop-${i + 1}-of-${pieces.length}.png`,
                })));
                const head = `区域 x=${x0}–${x1} y=${y0}–${y1} → ${pieces.length} 张 1:1 原像素（${width}px 宽）`;
                const ranges = pieces.map((piece, i) => `#${i + 1} y=${piece.top}–${piece.bottom}`).join(' | ');
                return { text: `${head}\n${ranges}`, images: refs.map((ref) => ({ ...ref })) };
            } catch (error) {
                return { text: 'long_crop 失败：' + String((error && error.message) || error) };
            }
        },
    })), 'dsh-long-image: long_crop');
}
