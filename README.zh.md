# dsh-long-image

一次调用读完一张**超长图**（长截图、聊天记录、整页网页、公众号/小红书长图）。插件按**空白行**切图，保证不切断任何一行文字，切出的每一片正好是视觉模型**按 1:1 像素**能看清的高度，并按阅读顺序附图。

```
long_see("D:/shots/notes.png")
→ 长图切片：1080×12000 png → 8 片（模型按 1:1 像素读取，单片高度上限 1548px）
  切口 7/7 落在空白行：文字零截断；空白行占比 36.7%（判定阈值 ≤2 个墨点）
  ★#1 y=     0–1530   高 1530
  ★#2 y=  1530–3002   高 1472
  ...
```

模型同时拿到**切片计划**和**图片本身**，可以继续 `long_see(path, from=3)` 往后读，或 `long_crop(path, y0, y1)` 放大某一段。

## 为什么要切

视觉请求不是随便塞图就行：DeepSeek 会把每张图投影到 **14px 的 patch 网格**，每轴 3:1 下采样成 token 格（**每格 42px**），单图上限 **1024 token**。刚好装进这个预算的图，会被**按原像素尺寸**送给模型——每个源像素都不丢；再多一个像素，服务端就整图重采样，小字立刻糊掉。

所以切片高度不是拍脑袋定的，是解出来的：

```
cellsWide = ceil(ceil(width / 14) / 3)
cellsTall = floor((1024 - 2) / (cellsWide + 1))
maxTileHeight = max(240, cellsTall * 42)
```

1080px 宽的页面，每片上限 1548px。`lib/geometry.js` 里的 `maxTileHeight()` 是唯一权威，切图计划由它生成。

## 为什么切口是安全的

`lib/profile.js` 会算一张**行墨迹剖面**：对每一像素行先估计背景亮度（取直方图主桶，并在桶内再细化），再统计偏离背景超过 `inkThreshold`（默认 26）的像素数。当某行的墨点数 `≤ max(2, round(width × 0.002))` 时，这一行判定为**安静行**——即只有背景。

`lib/tiler.js` 于是把每个切口放在一段安静区间的中心，优先选最接近理想高度的区间。这样切口不可能穿过字形、下划线或表格线。若整页太密找不到安静行，该片会退化为**软切**，并在计划里明确标出来，不会假装自己切干净了。

## 安装

还没发布到 npm，直接从仓库装。

```bash
# 在 dsh profile 目录里
pnpm add git+https://github.com/drdrdr666/dsh-long-image.git

# 开发时 link 本地目录
pnpm add link:C:/path/to/dsh-long-image
```

然后把插件加进 profile 的 `package.json` bundle 列表：

```json
"dsh": { "profile": { "bundles": ["…", "dsh-long-image"] } }
```

`cordis.patch.yml` 负责插入插件条目，无需其他配置。

## 工具

### `long_see`

| 参数 | 类型 | 含义 |
|---|---|---|
| `path` | string | 图片路径，绝对路径或相对会话工作目录 |
| `parts` | number | 强制切成几片（默认：在不糊的前提下尽量少切） |
| `from` / `to` | number | 只附这一段（1 起，默认全部，单次有上限） |
| `dryRun` | boolean | 只返回切片计划，不附图 |

### `long_crop`

| 参数 | 类型 | 含义 |
|---|---|---|
| `path` | string | 图片路径 |
| `y0` / `y1` | number | 上边界 / 下边界（不含） |
| `x0` / `x1` | number | 左 / 右边界，默认整幅宽度 |

`long_crop` 按**原图 1:1 像素**重新取一块区域——用于密排表格，或竖直方向读不懂时横着按列读。

## 支持格式

- **PNG** 与**基线 JPEG**：完整解码、真实墨迹剖面、安全切口。
- WebP / GIF / 渐进式 JPEG：不做像素解码，只给出**等高的盲切计划**并明确警告——想要安全切口请先转 PNG。

限制：单图 1.2 亿像素、80MB，均可通过参数放宽。

## 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `LONG_IMAGE_TILE_TOKENS` | `1024` | 视觉通道单图 token 预算 |
| `LONG_IMAGE_PATCH_PIXELS` | `14` | 服务端 patch 尺寸 |
| `LONG_IMAGE_CELL_PIXELS` | `42` | patch × 下采样比例 |
| `LONG_IMAGE_MAX_ATTACH` | `12` | 单次调用最多附几张 |

## 开发

```bash
python tests/make-fixtures.py   # 需要 Python 3 + Pillow；测试图不入库
node tests/run.mjs              # 16 项检查：解码、墨迹剖面、切口安全性、切片
```

测试直接断言最关键的不变量：**每个切口所在行必须是安静行**（浅色与深色主题各测一遍），且每一片都不超高度预算。

## 说明

`0.2.2` 修好了**基线 JPEG 解码**。此前把熵编码数据的范围错传成 SOS 段结束，位读取器在第一个块就"读完"了，于是每个块都解出同样的假系数，整张图退化成 **8 像素周期的灰噪点**——而基于墨迹比例的切口安全检查还会照样报"全部落在空白行"。现在测试直接断言真实的明暗像素占比与行内容多样性，这类退化不可能再悄悄通过。

从 `0.2.1` 起，工具返回**完整的附件引用**（`attachmentId` + `mediaType` / `width` / `height` / `bytes` / `name`）。更早的版本只回传 id，宿主在下一轮请求时无法还原图片元数据，导致该会话此后每一轮都报 `DeepSeek Messages transport failed`。如果你有 `0.2.0` 写坏的会话，需要重建那些图片块或丢弃对应轮次。

## 许可

MIT
