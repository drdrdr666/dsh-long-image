"""Generate long-image fixtures plus independent ground truth.

Ground truth is measured after rendering: a row is an "ink row" if any pixel
differs from the page background. That keeps the assertions independent of the
plugin's own ink profile.
"""

import json
import os
import random

from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]

PARAGRAPHS = [
    "长图阅读测试：这一行是为了确认切口不会压到文字上。",
    "第二行：卷积神经网络在看图时会先把图像压到固定的 token 网格。",
    "第三行：如果一行字正好落在切口上，模型就只能看到半个字。",
    "第四行：因此切片位置必须落在没有墨迹的空白行上。",
    "第五行：空白行的判定标准是这一行没有任何与背景差异明显的像素。",
    "第六行：1234567890 abcdefghijklmnop qrstuvwxyz 混排也要正确。",
    "第七行：This line is English and mixed with 中文 to test metrics.",
    "第八行：表格线、下划线、加粗标题都要被当作墨迹处理。",
    "第九行：一整段没有空行时，只能挑选墨迹最少的一行并加重叠。",
    "第十行：段落之间通常有几个像素的间距，那才是最好的切口。",
]


def pick_font(size):
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def ink_rows(image, background):
    """Rows that contain at least one pixel different from the background."""
    width, height = image.size
    pixels = image.load()
    rows = []
    for y in range(height):
        inked = False
        for x in range(width):
            if pixels[x, y][:3] != background:
                inked = True
                break
        rows.append(inked)
    return rows


def build(name, width, target_height, dark=False, quality=None):
    bg = (24, 24, 28) if dark else (255, 255, 255)
    fg = (232, 232, 236) if dark else (28, 28, 32)
    image = Image.new("RGB", (width, target_height), bg)
    draw = ImageDraw.Draw(image)
    font = pick_font(30)
    bold = pick_font(34)

    random.seed(7)
    y = 24
    block = 0
    while y < target_height - 120:
        if block % 4 == 0:
            draw.text((40, y), f"{block // 4 + 1}. 小节标题 / section heading", font=bold, fill=fg)
            y += 52
        for line in PARAGRAPHS:
            if y >= target_height - 90:
                break
            draw.text((48, y), line, font=font, fill=fg)
            y += 46
        y += random.choice([26, 34, 42])
        block += 1

    rows = ink_rows(image, bg)
    ink = []
    start = None
    for y, inked in enumerate(rows):
        if inked and start is None:
            start = y
        elif not inked and start is not None:
            ink.append([start, y - 1])
            start = None
    if start is not None:
        ink.append([start, len(rows) - 1])

    meta = {
        "file": name,
        "width": width,
        "height": target_height,
        "background": list(bg),
        "inkRows": ink,
    }
    if quality is None:
        image.save(os.path.join(OUT, name), optimize=False)
    else:
        image.save(os.path.join(OUT, name), quality=quality, subsampling=2, progressive=False)
        meta["note"] = "baseline JPEG (4:2:0), ink rows measured on the pre-encode raster"
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False)
    print(name, image.size, "ink runs:", len(ink))


build("long_zh.png", 1080, 12000)
build("long_zh.jpg", 1080, 9000, quality=92)
build("long_dark.png", 900, 8000, dark=True)
