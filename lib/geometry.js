/**
 * Vision request geometry and shared limits.
 *
 * A DeepSeek chat route projects every image onto a 14px patch grid, downsamples
 * 3:1 per axis into token cells and caps one image at 1024 tokens. An image that
 * fits that budget is sent at its own pixel size, so a tile cut to the budget is
 * delivered to the model with every source pixel intact — that is the whole
 * reason the cut heights are computed instead of picked by hand.
 */

export const DEFAULTS = {
    tileMaxTokens: Number(process.env.LONG_IMAGE_TILE_TOKENS) || 1024,
    patchPixels: Number(process.env.LONG_IMAGE_PATCH_PIXELS) || 14,
    cellPixels: Number(process.env.LONG_IMAGE_CELL_PIXELS) || 42,
    patchToCellRatio: 3,
    maxAttachPerCall: Number(process.env.LONG_IMAGE_MAX_ATTACH) || 12,
    softOverlap: 28,
    maxPixels: 120_000_000,
    maxFileBytes: 80 * 1024 * 1024,
};

/**
 * Largest tile height the model still receives at 1:1 for this width.
 * @param {number} width source tile width in pixels
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {number} tile height budget in pixels
 */
export function maxTileHeight(width, options = {}) {
    const opt = { ...DEFAULTS, ...options };
    const patch = opt.patchPixels;
    const cell = opt.cellPixels;
    const padded = Math.ceil(width / patch) * patch;
    const cellsWide = Math.ceil(Math.floor(padded / patch) / opt.patchToCellRatio);
    const cellsTall = Math.floor((opt.tileMaxTokens - 2) / (cellsWide + 1));
    return Math.max(240, cellsTall * cell);
}
