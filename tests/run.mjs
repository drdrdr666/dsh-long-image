/**
 * Plain-node verification for the geometry, codecs and cut planning.
 * Run: node tests/run.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodePng, encodePng } from '../lib/png.js';
import { decodeJpeg } from '../lib/jpeg.js';
import { decodeImage, probeImage } from '../lib/image.js';
import { inkProfile, quietShare } from '../lib/profile.js';
import { plan } from '../lib/plan.js';
import { maxTileHeight } from '../lib/geometry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const meta = (name) => JSON.parse(readFileSync(fixture(name + '.json'), 'utf8'));

let checks = 0;
const ok = (label, extra = '') => {
    checks++;
    console.log('  ok  ' + label + (extra ? ' — ' + extra : ''));
};

function assertCutsClearOfInk(result, truth) {
    const runs = truth.inkRows;
    for (const boundary of result.boundaries) {
        const hit = runs.find(([a, b]) => boundary.y >= a && boundary.y <= b);
        assert.equal(
            hit,
            undefined,
            `cut y=${boundary.y} (${boundary.kind}) intersects ink rows ${hit && hit.join('-')}`,
        );
    }
}

function assertCoverage(result) {
    assert.equal(result.tiles[0].coreY0, 0, 'first tile must start at 0');
    assert.equal(result.tiles[result.tiles.length - 1].coreY1, result.height, 'last tile must end at height');
    for (let i = 1; i < result.tiles.length; i++) {
        assert.equal(result.tiles[i].coreY0, result.tiles[i - 1].coreY1, 'tiles must be contiguous');
    }
    for (const tile of result.tiles) {
        assert.ok(tile.y1 > tile.y0, 'tile must have positive height');
        assert.ok(
            tile.y1 - tile.y0 <= result.safeTileHeight * 1.05,
            `tile ${tile.index} is ${tile.y1 - tile.y0}px, budget ${result.safeTileHeight}px`,
        );
    }
}

console.log('\n[1] PNG codec round-trip');
{
    const png = readFileSync(fixture('long_zh.png'));
    const decoded = decodePng(png);
    assert.deepEqual([decoded.width, decoded.height], [1080, 12000]);
    const tile = Buffer.alloc(64 * 40 * 4);
    for (let i = 0; i < tile.length; i += 4) {
        tile[i] = i % 251;
        tile[i + 1] = (i * 7) % 253;
        tile[i + 2] = (i * 13) % 255;
        tile[i + 3] = 255;
    }
    const re = decodePng(encodePng(tile, 64, 40));
    assert.equal(re.width, 64);
    assert.equal(re.height, 40);
    assert.ok(re.rgba.equals(tile), 'PNG encode/decode must be lossless');
    ok('decode 1080x12000 PNG', `${png.length} bytes`);
    ok('encode+decode lossless 64x40');
}

console.log('\n[2] geometry: tile height budget');
{
    const w1080 = maxTileHeight(1080);
    assert.ok(w1080 > 1400 && w1080 < 1700, 'unexpected budget for 1080px width: ' + w1080);
    ok('1080px wide → tile budget', w1080 + 'px');
    ok('900px wide → tile budget', maxTileHeight(900) + 'px');
    ok('2400px wide → tile budget', maxTileHeight(2400) + 'px');
}

console.log('\n[3] baseline JPEG decode');
{
    const jpg = readFileSync(fixture('long_zh.jpg'));
    const img = decodeImage(jpg);
    assert.deepEqual([img.width, img.height], [1080, 9000]);
    const raw = decodeJpeg(jpg);
    assert.equal(raw.components, 3);
    assert.equal(raw.planes.length, 3);

    // 解码结果必须真的是白底黑字。曾经因为熵数据范围传成了 SOS 段结束，
    // 位流一开局就"读完"，每个块解出同样的假系数，整图退化成 8px 周期的灰噪点，
    // 而按墨迹比例做的安全检查却依然报"切口全在空白行"。
    let dark = 0;
    let light = 0;
    let total = 0;
    for (let y = 0; y < img.height; y += 7) {
        const row = img.rowLuma(y);
        for (let x = 0; x < img.width; x += 5) {
            const v = row[x];
            total++;
            if (v < 80) dark++;
            if (v > 200) light++;
        }
    }
    const darkShare = dark / total;
    const lightShare = light / total;
    assert.ok(lightShare > 0.6, `JPEG 纸面（亮部）占比只有 ${(lightShare * 100).toFixed(1)}% —— 解码退化`);
    assert.ok(darkShare > 0.02, `JPEG 文字（暗部）占比只有 ${(darkShare * 100).toFixed(1)}% —— 解码退化`);

    // 位流不推进时，整图会被同一个 8×8 块平铺：大量行内容一模一样。
    // 正常文字页每隔几十像素就会换行文字，行指纹几乎全不相同。
    const rowFingerprints = new Set();
    let sampled = 0;
    for (let y = 0; y < img.height; y += 97) {
        rowFingerprints.add(Array.from(img.rowLuma(y).slice(0, 256)).join(','));
        sampled++;
    }
    assert.ok(
        rowFingerprints.size > sampled * 0.5,
        `JPEG 行内容重复率过高（${rowFingerprints.size}/${sampled} 唯一）—— 整图疑似被平铺`,
    );

    const profile = inkProfile(img);
    const share = quietShare(profile);
    assert.ok(share > 0.05, 'too few blank rows detected in JPEG: ' + share);
    assert.ok(share < 0.65, `JPEG 空白行占比 ${(share * 100).toFixed(1)}% 异常偏高 —— 解码退化`);
    ok('decode 1080x9000 baseline JPEG',
        `blank rows ${(share * 100).toFixed(1)}%, dark ${(darkShare * 100).toFixed(1)}%, light ${(lightShare * 100).toFixed(1)}%`);
}

console.log('\n[4] plan: cuts never touch a text row (PNG)');
{
    const truth = meta('long_zh.png');
    const result = plan(fixture('long_zh.png'));
    assert.equal(result.format, 'png');
    assert.ok(result.parts >= 5, 'expected several parts, got ' + result.parts);
    assert.equal(result.softCuts.length, 0, 'PNG fixture has blank rows everywhere, expected only clean cuts');
    assertCutsClearOfInk(result, truth);
    assertCoverage(result);
    ok(`1080x12000 → ${result.parts} parts`, result.tiles.map((t) => `${t.y0}-${t.y1}`).join(' '));
    ok('every cut lands on a blank row', `${result.boundaries.length} cuts`);
    ok('tiles contiguous and every tile within budget');
}

console.log('\n[5] plan: dark theme (light text on dark page)');
{
    const truth = meta('long_dark.png');
    const result = plan(fixture('long_dark.png'));
    assertCutsClearOfInk(result, truth);
    assertCoverage(result);
    ok(`900x8000 → ${result.parts} parts, all cuts blank`);
}

console.log('\n[6] plan: JPEG end to end');
{
    const result = plan(fixture('long_zh.jpg'));
    assert.equal(result.format, 'jpeg');
    assertCoverage(result);
    assert.ok(result.parts >= 4, 'expected parts for a 9000px JPEG, got ' + result.parts);
    ok(`1080x9000 JPEG → ${result.parts} parts`, `${result.softCuts.length} soft cuts`);
}

console.log('\n[7] plan: forced part count, short image passthrough');
{
    const forced = plan(fixture('long_zh.png'), { parts: 12 });
    assert.equal(forced.parts, 12);
    assertCoverage(forced);
    ok('parts=12 honoured, still within budget');

    // parts=1 on a 12000px page cannot stay 1:1, so the planner must keep the
    // required count and say why instead of silently shrinking the image.
    const squeezed = plan(fixture('long_zh.png'), { parts: 1 });
    assert.ok(squeezed.parts > 1, 'tall image must not collapse into one unreadable part');
    assert.ok(squeezed.warnings.some((w) => w.includes('至少要')), 'missing override warning');
    ok('parts=1 on a 12000px page → kept ' + squeezed.parts + ' parts with a warning');

    const shortFile = path.join(here, 'fixtures', 'short.png');
    const shortRgba = Buffer.alloc(420 * 600 * 4, 250);
    writeFileSync(shortFile, encodePng(shortRgba, 420, 600));
    const single = plan(shortFile);
    assert.equal(single.parts, 1);
    ok('420x600 image → single part, no cut');
}

console.log('\n[8] tile extraction matches the source raster');
{
    const png = readFileSync(fixture('long_zh.png'));
    const img = decodeImage(png);
    const rgba = img.tile(0, 0, 64, 32);
    const direct = decodePng(png).rgba;
    for (let y = 0; y < 32; y++) {
        const from = (y * 1080) * 4;
        assert.ok(rgba.subarray(y * 64 * 4, (y + 1) * 64 * 4).equals(direct.subarray(from, from + 64 * 4)), 'tile row ' + y);
    }
    ok('tile(0,0,64,32) equals the top-left of the source');
    const probe = probeImage(png);
    assert.deepEqual([probe.width, probe.height, probe.format], [1080, 12000, 'png']);
    ok('probeImage reports png 1080x12000');
}

console.log(`\n${checks} checks passed.\n`);
