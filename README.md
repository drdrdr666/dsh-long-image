# dsh-long-image

Read a **very tall image** (long screenshot, chat log, full web page, 小红书/公众号长图) in one call. The plugin cuts it on **blank rows** so no text line is ever split, at the exact height the vision model resolves **1:1**, and attaches the parts in reading order.

```
long_see("D:/shots/notes.png")
→ 长图切片：1080×12000 png → 8 片（模型按 1:1 像素读取，单片高度上限 1548px）
  切口 7/7 落在空白行：文字零截断；空白行占比 36.7%（判定阈值 ≤2 个墨点）
  ★#1 y=     0–1530   高 1530
  ★#2 y=  1530–3002   高 1472
  ...
```

The model gets the plan **and** the images, so it can keep reading part by part with `long_see(path, from=3)` and zoom with `long_crop(path, y0, y1)`.

## Why cut at all

A vision request is not free-form: DeepSeek projects every image onto a **14 px patch grid**, downsamples 3:1 per axis into token cells (**42 px per cell**) and caps one image at **1024 tokens**. An image that fits that budget is delivered to the model **at its own pixel size** — every source pixel intact. One pixel further and the provider quietly rescales the whole thing, and small text turns to mush.

So the tile height is not a taste decision, it is solved:

```
cellsWide = ceil(ceil(width / 14) / 3)
cellsTall = floor((1024 - 2) / (cellsWide + 1))
maxTileHeight = max(240, cellsTall * 42)
```

For a 1080 px-wide page that is 1548 px per tile. `maxTileHeight()` in `lib/geometry.js` is the single source of truth; the cut plan is built from it.

## Why the cuts are safe

`lib/profile.js` builds a **row ink profile**: for every pixel row it estimates the background level (dominant luma bucket, refined inside that bucket), then counts pixels that deviate from it by more than `inkThreshold` (default 26). A row is *quiet* when its ink count is `≤ max(2, round(width × 0.002))` — i.e. background only.

`lib/tiler.js` then places each cut at the centre of a quiet run, preferring the run closest to the ideal height. A cut can therefore never pass through a glyph, an underline or a table rule. If the page is too dense to find a quiet row, the tile keeps a **soft cut** and says so in the plan instead of pretending it was clean.

## Install

Not on npm yet — install straight from this repository.

```bash
# inside your dsh profile directory
pnpm add git+https://github.com/drdrdr666/dsh-long-image.git

# or link a local checkout while developing
pnpm add link:C:/path/to/dsh-long-image
```

Then add it to the profile bundle list in `package.json`:

```json
"dsh": { "profile": { "bundles": ["…", "dsh-long-image"] } }
```

`cordis.patch.yml` inserts the plugin entry; no further config is required.

## Tools

### `long_see`

| parameter | type | meaning |
|---|---|---|
| `path` | string | image path, absolute or relative to the session working directory |
| `parts` | number | force a part count (default: as few parts as the model still resolves 1:1) |
| `from` / `to` | number | attach only this 1-based range (default: all, capped per call) |
| `dryRun` | boolean | return the cut plan only, no attachments |

### `long_crop`

| parameter | type | meaning |
|---|---|---|
| `path` | string | image path |
| `y0` / `y1` | number | top row / bottom row (exclusive) |
| `x0` / `x1` | number | left / right column, defaults to the full width |

`long_crop` re-reads a region at **1:1 original pixels** — for dense tables, or a wide image read column by column.

## Supported formats

- **PNG** and **baseline JPEG**: full decode, real ink profiling, safe cuts.
- WebP / GIF / progressive JPEG: no pixel decode, so the plugin returns a **blind equal-height plan** with an explicit warning — convert to PNG first for safe cuts.

Limits: 120 Mpx and 80 MB per file, both overridable.

## Environment

| variable | default | meaning |
|---|---|---|
| `LONG_IMAGE_TILE_TOKENS` | `1024` | per-image token budget of the vision route |
| `LONG_IMAGE_PATCH_PIXELS` | `14` | provider patch size |
| `LONG_IMAGE_CELL_PIXELS` | `42` | patch × downsample ratio |
| `LONG_IMAGE_MAX_ATTACH` | `12` | max images attached in one call |

## Development

```bash
python tests/make-fixtures.py   # needs Python 3 + Pillow; fixtures are git-ignored
node tests/run.mjs              # 16 checks: decode, ink profile, cut safety, tiling
```

The test suite asserts the important invariant directly: **every cut row must be a quiet row**, for both a light theme and a dark theme page, and every tile must stay within the height budget.

## Notes

`0.2.2` fixes **baseline JPEG decoding**. The entropy-coded segment range used to be passed as the SOS segment end, so the bit reader ran dry at the very first block, every block decoded to the same fake coefficients, and the whole image degenerated into **8-pixel-periodic grey noise** — while the ink-based cut safety check happily reported "all cuts on blank rows". The suite now asserts real dark/light pixel shares plus row variety, so this can never pass silently again.

Since `0.2.1` the tools return **complete attachment references** (`attachmentId` + `mediaType` / `width` / `height` / `bytes` / `name`). Earlier builds returned the id alone, which made the host unable to rebuild the image on the next request — every later turn in that session failed with `DeepSeek Messages transport failed`. If you have a session written by `0.2.0`, recreate the image blocks or drop those turns.

## License

MIT
