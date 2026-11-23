/**
 * Row ink profile: how much non-background ink each pixel row carries.
 *
 * The profile is what makes a cut safe. A row whose ink count is at or below the
 * quiet threshold contains only background, so a cut placed there cannot pass
 * through a glyph, an underline or a table rule.
 */

/**
 * Build the profile for one decoded image.
 * @param {{width:number,height:number,rowLuma:(y:number)=>Uint8Array}} img
 * @param {{inkThreshold?:number, quietRatio?:number}} [options]
 * @returns {{
 *   width:number, height:number,
 *   ink:Int32Array, quiet:Uint8Array,
 *   quietThreshold:number,
 *   gaps:Array<{start:number,end:number,center:number,length:number}>,
 * }}
 */
export function inkProfile(img, options = {}) {
    const inkThreshold = options.inkThreshold ?? 26;
    const quietRatio = options.quietRatio ?? 0.002;
    const { width, height } = img;
    const ink = new Int32Array(height);
    const quietThreshold = Math.max(2, Math.round(width * quietRatio));
    const histogram = new Int32Array(64);

    for (let y = 0; y < height; y++) {
        const row = img.rowLuma(y);
        histogram.fill(0);
        const step = width > 600 ? 3 : 1;
        for (let x = 0; x < width; x += step) histogram[row[x] >> 2]++;
        let bgBucket = 0;
        let bgCount = -1;
        for (let b = 0; b < 64; b++) {
            if (histogram[b] > bgCount) {
                bgCount = histogram[b];
                bgBucket = b;
            }
        }
        // Refine the background level inside the dominant bucket.
        let sum = 0;
        let count = 0;
        const lo = bgBucket << 2;
        const hi = lo + 4;
        for (let x = 0; x < width; x++) {
            const v = row[x];
            if (v >= lo && v < hi) {
                sum += v;
                count++;
            }
        }
        const bg = count > 0 ? sum / count : lo + 2;
        let inked = 0;
        for (let x = 0; x < width; x++) {
            const d = row[x] - bg;
            if (d > inkThreshold || d < -inkThreshold) inked++;
        }
        ink[y] = inked;
    }

    const quiet = new Uint8Array(height);
    for (let y = 0; y < height; y++) quiet[y] = ink[y] <= quietThreshold ? 1 : 0;

    const gaps = [];
    let runStart = -1;
    for (let y = 0; y < height; y++) {
        if (quiet[y]) {
            if (runStart < 0) runStart = y;
        } else if (runStart >= 0) {
            gaps.push(makeGap(runStart, y - 1));
            runStart = -1;
        }
    }
    if (runStart >= 0) gaps.push(makeGap(runStart, height - 1));

    return { width, height, ink, quiet, quietThreshold, gaps };
}

function makeGap(start, end) {
    return { start, end, center: (start + end) >> 1, length: end - start + 1 };
}

/** Share of rows that carry no ink; low values mean a dense page with no safe cuts. */
export function quietShare(profile) {
    let quietRows = 0;
    for (let y = 0; y < profile.height; y++) quietRows += profile.quiet[y];
    return profile.height > 0 ? quietRows / profile.height : 0;
}
