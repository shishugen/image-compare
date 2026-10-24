#!/usr/bin/env python3
"""生成应用图标源图（1024x1024 PNG），供 `npm run icon` 派生各尺寸图标。"""
from PIL import Image, ImageDraw
from pathlib import Path

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "assets" / "app-icon-source.png"


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return m


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # 深色渐变底
    top, bottom = (42, 48, 62), (20, 22, 28)
    grad = Image.new("RGB", (SIZE, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        ImageDraw.Draw(grad).line([(0, y), (SIZE, y)], fill=c)
    img.paste(grad, (0, 0), rounded_mask(SIZE, 220))

    d = ImageDraw.Draw(img)
    # 左右两张图框
    frame_y, frame_h = 250, 520
    left_x, right_x = 150, 554
    d.rounded_rectangle([left_x, frame_y, left_x + 384, frame_y + frame_h], 36,
                        fill=(232, 238, 248, 255))
    d.rounded_rectangle([right_x, frame_y, right_x + 384, frame_y + frame_h], 36,
                        fill=(120, 170, 250, 255))
    # 中间分隔高光
    d.rectangle([left_x + 384, frame_y, right_x, frame_y + frame_h], fill=(255, 255, 255, 255))
    # 放大镜（表示缩放/比对）
    cx, cy, r = 512, 690, 130
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=34)
    d.line([cx + r - 30, cy + r - 30, cx + r + 90, cy + r + 90], fill=(255, 255, 255, 255), width=44)

    img.save(OUT)
    print(f"图标已生成: {OUT}")


if __name__ == "__main__":
    main()
