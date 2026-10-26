#!/usr/bin/env python3
"""生成应用图标源图（1024x1024 PNG），供 `npm run icon` 派生各尺寸图标。

图案是「一张图、左右两版，中间一道对比滑块」——直接对应本软件的主交互。
配色取自界面本身：--bg #1a1c22 / --accent #4c8dff。

几个尺寸是踩出来的，改之前先看注释：
① 卡占画布 74%（758px）。试过 64%，缩到 32px 后左半跟深色背景糊成一团，
   整个图标读成「黑块 + 蓝块」；
② 左半用中石板灰而不是更暗的灰。同样是为了 32px：暗档在深色底上分不出左右；
③ 滑杆和把手的线宽一律按卡宽的比例给（不是写死像素），否则小尺寸下最先消失的
   就是这两个核心识别元素；
④ 太阳只放在左半。放中间会跟滑杆白线叠成两个白圆，放亮灰上又没有对比。
"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
from pathlib import Path

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "assets" / "app-icon-source.png"

ACCENT = (76, 141, 255)           # 界面 --accent
BG_TOP = (37, 43, 55)             # 比 --bg #1a1c22 略提一档，免得跟桌面壁纸分不开
BG_BOTTOM = (16, 18, 23)
LEFT_TOP, LEFT_BOTTOM = (128, 140, 162), (72, 80, 96)  # 左半「原图」：中石板灰
INK = (26, 28, 34)                # 把手上的双三角，取自 --bg

CARD = 758                        # 卡边长，占画布 74%
CARD_POS = ((SIZE - CARD) // 2, (SIZE - CARD) // 2)
CARD_RADIUS = int(CARD * 0.145)
SPLIT_FRAC = 0.5                  # 滑杆在卡内的横向位置
LINE_FRAC = 0.026                 # 滑杆线宽 / 卡宽
KNOB_FRAC = 0.105                 # 把手半径 / 卡宽


def vgrad(size, top, bottom):
    """竖向线性渐变（RGB → RGBA）"""
    w, h = size
    g = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.convert("RGBA")


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def clip(tile, layer):
    """把 layer 按 tile 自身的 alpha 裁一遍，保证内容不溢出圆角"""
    layer.putalpha(ImageChops.multiply(tile.split()[3], layer.split()[3]))
    return Image.alpha_composite(tile, layer)


def glow(img, box, radius, color, blur=40, alpha=56):
    """卡外一圈淡淡的蓝辉光，把主体从背景里托出来"""
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(list(box), radius, fill=color + (alpha,))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def make_card():
    w, h = CARD, CARD
    card = vgrad((w, h), LEFT_TOP, LEFT_BOTTOM)
    card.putalpha(rounded_mask((w, h), CARD_RADIUS))

    # 右半压蓝：同一张图的「另一版」
    acc = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    split_x = int(w * SPLIT_FRAC)
    ImageDraw.Draw(acc).rectangle([split_x, 0, w, h], fill=ACCENT + (232,))
    card = clip(card, acc)

    # 照片内容：远山两道 + 左半一个太阳（画在压色之后，两半才有同一张图的感觉）
    art = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    d.ellipse([-int(w * 0.35), int(h * 0.52), int(w * 0.62), int(h * 1.42)], fill=(255, 255, 255, 40))
    d.ellipse([int(w * 0.28), int(h * 0.62), int(w * 1.35), int(h * 1.60)], fill=(255, 255, 255, 28))
    sun_r = int(w * 0.075)
    sun_cx, sun_cy = int(w * 0.26), int(h * 0.26)
    d.ellipse([sun_cx - sun_r, sun_cy - sun_r, sun_cx + sun_r, sun_cy + sun_r], fill=(255, 255, 255, 255))
    card = clip(card, art)

    # 滑杆 + 把手（⇄ 用两个实心三角，早期用折线画出来读成了 <> 代码括号）
    d = ImageDraw.Draw(card)
    d.line([(split_x, int(h * 0.05)), (split_x, int(h * 0.95))],
           fill=(255, 255, 255, 255), width=max(2, int(w * LINE_FRAC)))
    kr = int(w * KNOB_FRAC)
    cy = h // 2
    d.ellipse([split_x - kr, cy - kr, split_x + kr, cy + kr], fill=(255, 255, 255, 255))
    tri, gap = int(kr * 0.36), int(kr * 0.15)
    d.polygon([(split_x - gap, cy), (split_x - gap - tri, cy - tri), (split_x - gap - tri, cy + tri)],
              fill=INK + (255,))
    d.polygon([(split_x + gap, cy), (split_x + gap + tri, cy - tri), (split_x + gap + tri, cy + tri)],
              fill=INK + (255,))
    return card


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    img.paste(vgrad((SIZE, SIZE), BG_TOP, BG_BOTTOM), (0, 0), rounded_mask((SIZE, SIZE), 220))

    x0, y0 = CARD_POS
    glow(img, (x0 - 16, y0 - 16, x0 + CARD + 16, y0 + CARD + 16), CARD_RADIUS + 3, ACCENT)
    img.alpha_composite(make_card(), CARD_POS)

    img.save(OUT)
    print(f"图标已生成: {OUT}")


if __name__ == "__main__":
    main()
