/**
 * Cut planning: turn a row ink profile into tile boundaries that never cross a
 * glyph row, then keep every tile inside the height the vision model resolves
 * at 1:1.
 */

/**
 * @param {{
 *   profile: ReturnType<import('./profile.js').inkProfile>,
 *   maxTileHeight: number,
 *   partsHint?: number,
 *   maxParts?: number,
 *   minTileHeight?: number,
 *   softOverlap?: number,
 * }} options
 */
export function planTiles(options) {
    const {
        profile,
        maxTileHeight,
        partsHint,
        maxParts = 40,
        minTileHeight = 120,
        softOverlap = 28,
    } = options;
    const { width, height } = profile;
    const warnings = [];

    if (height <= 0) throw new Error('empty image');
    if (maxTileHeight < 240 && width > 2400) {
        warnings.push(`图宽 ${width}px 超过模型 1:1 可读宽度，单张切高被压到 ${maxTileHeight}px；建议用 long_crop 按 x 列分块`);
    }
    const safeTileHeight = Math.max(240, Math.floor(maxTileHeight));

    const needed = Math.max(1, Math.ceil(height / safeTileHeight));
    let parts = partsHint && partsHint > 0 ? Math.floor(partsHint) : needed;
    parts = Math.max(1, Math.min(maxParts, parts));
    if (partsHint && parts < needed) {
        warnings.push(`请求 ${Math.floor(partsHint)} 片，但保 1:1 清晰度至少要 ${needed} 片，已按 ${needed} 片切`);
        parts = needed;
    }
    if (parts > 16) warnings.push(`${parts} 片超过单次可附张数的常规上限，建议分两次读（from/to）`);

    /** @type {Array<{y:number, kind:'gap'|'soft', gapLength:number, ink:number}>} */
    const boundaries = [];

    if (parts > 1) {
        const step = height / parts;
        for (let k = 1; k < parts; k++) {
            const ideal = Math.round(k * step);
            const window = Math.min(500, Math.max(32, Math.round(step * 0.4)));
            const lastY = boundaries.length ? boundaries[boundaries.length - 1].y : -1;
            const lo = Math.max(lastY + minTileHeight + 1, ideal - window, 1);
            const hi = Math.min(height - minTileHeight - 1, ideal + window);
            if (hi <= lo) continue;
            const cut = pickCut(profile, ideal, lo, hi);
            if (cut) boundaries.push(cut);
        }
    }

    // Refinement: any tile that still exceeds the height budget gets one more cut
    // inside it, placed on the best blank gap near its middle.
    for (let pass = 0; pass < 8; pass++) {
        let inserted = false;
        const edges = [0, ...boundaries.map((b) => b.y), height];
        for (let i = 0; i < edges.length - 1; i++) {
            const y0 = edges[i];
            const y1 = edges[i + 1];
            if (y1 - y0 <= safeTileHeight * 1.02) continue;
            const ideal = Math.round((y0 + y1) / 2);
            const lo = Math.max(y0 + minTileHeight, ideal - Math.round(safeTileHeight * 0.45));
            const hi = Math.min(y1 - minTileHeight, ideal + Math.round(safeTileHeight * 0.45));
            if (hi <= lo) continue;
            const cut = pickCut(profile, ideal, lo, hi);
            if (!cut) continue;
            if (boundaries.some((b) => Math.abs(b.y - cut.y) < 2)) continue;
            boundaries.push(cut);
            boundaries.sort((a, b) => a.y - b.y);
            inserted = true;
            break;
        }
        if (!inserted) break;
    }

    const tiles = [];
    for (let i = 0; i <= boundaries.length; i++) {
        const y0 = i === 0 ? 0 : boundaries[i - 1].y;
        const y1 = i === boundaries.length ? height : boundaries[i].y;
        const cutBefore = i === 0 ? null : boundaries[i - 1];
        const cutAfter = i === boundaries.length ? null : boundaries[i];
        const padTop = cutBefore && cutBefore.kind === 'soft' && cutBefore.ink > 0 ? softOverlap : 0;
        const padBottom = cutAfter && cutAfter.kind === 'soft' && cutAfter.ink > 0 ? softOverlap : 0;
        tiles.push({
            index: i + 1,
            y0: Math.max(0, y0 - padTop),
            y1: Math.min(height, y1 + padBottom),
            coreY0: y0,
            coreY1: y1,
            cutBefore: cutBefore ? cutBefore.kind : null,
            cutAfter: cutAfter ? cutAfter.kind : null,
        });
    }

    const softCuts = boundaries.filter((b) => b.kind === 'soft');
    if (softCuts.length > 0) {
        warnings.push(
            `${softCuts.length} 个切口落在非空白行（y=${softCuts.map((b) => b.y).join(', ')}），`
            + `已向两侧各多带 ${softOverlap}px 重叠，边界内容在相邻两片里都能看到`,
        );
    }

    for (const tile of tiles) {
        if (tile.y1 - tile.y0 > safeTileHeight * 1.05) {
            warnings.push(`第 ${tile.index} 片高 ${tile.y1 - tile.y0}px，超过 ${safeTileHeight}px 预算`);
        }
    }

    return {
        width,
        height,
        parts: tiles.length,
        tiles,
        boundaries,
        softCuts,
        safeTileHeight,
        clean: softCuts.length === 0,
        warnings,
    };
}

/** @returns {{y:number, kind:'gap'|'soft', gapLength:number, ink:number}|null} */
function pickCut(profile, ideal, lo, hi) {
    let best = null;
    let bestScore = -Infinity;
    for (const gap of profile.gaps) {
        if (gap.center < lo || gap.center > hi || gap.length < 2) continue;
        const score = Math.min(gap.length, 400) - Math.abs(gap.center - ideal) * 0.9;
        if (score > bestScore) {
            bestScore = score;
            best = { y: gap.center, kind: 'gap', gapLength: gap.length, ink: 0 };
        }
    }
    if (best) return best;

    // No blank run: take the least-inked row and let the caller add overlap.
    let minY = -1;
    let minInk = Infinity;
    for (let y = Math.max(1, lo); y <= Math.min(profile.height - 2, hi); y++) {
        if (profile.ink[y] < minInk) {
            minInk = profile.ink[y];
            minY = y;
        }
    }
    if (minY < 0) return null;
    return { y: minY, kind: 'soft', gapLength: 0, ink: minInk };
}
