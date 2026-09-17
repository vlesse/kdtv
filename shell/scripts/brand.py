# -*- coding: utf-8 -*-
"""Emit the Android vector drawables for the KDTV brand.

Vector drawables cannot draw text, so the wordmark is converted to outlines
here (Noto Sans Bold - the same family the TV interface itself uses) and the
result is committed as path data. Re-run this script to change the mark.
"""
import os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

FONT = "C:/Windows/Fonts/NotoSans-Bold.ttf"
ACC, INK, LIGHT = "#FF2D55", "#0B1220", "#F2F5F9"
RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src", "main", "res")

_f = TTFont(FONT)
_upem = _f["head"].unitsPerEm
_cap = _f["OS/2"].sCapHeight or int(_upem * 0.7)
_cmap, _gs, _hmtx = _f.getBestCmap(), _f.getGlyphSet(), _f["hmtx"]


def glyphs(text, cap_h, track, ox, oy):
    """Outlines for `text` with its baseline at (ox, oy). Returns (d, width)."""
    s, parts, x = cap_h / _cap, [], 0.0
    for ch in text:
        g = _cmap[ord(ch)]
        pen = SVGPathPen(_gs, ntos=lambda v: f"{v:.2f}")
        _gs[g].draw(TransformPen(pen, Transform(s, 0, 0, -s, ox + x, oy)))
        if pen.getCommands():
            parts.append(pen.getCommands())
        x += _hmtx[g][0] * s + track
    return " ".join(parts), x - track


def width(text, cap_h, track):
    return glyphs(text, cap_h, track, 0, 0)[1]


def path(d, colour):
    return f'    <path\n        android:fillColor="{colour}"\n        android:pathData="{d}" />'


def vector(w, h, body, note):
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!--\n{note}\n-->\n'
            f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            f'    android:width="{w}dp"\n    android:height="{h}dp"\n'
            f'    android:viewportWidth="{w}"\n    android:viewportHeight="{h}">\n\n'
            f'{body}\n</vector>\n')


def rect(w, h, colour, y=0, x=0):
    return path(f"M{x},{y}h{w}v{h}h-{w}z", colour)


def centred(pairs, cap, track, cy_baseline, box_w):
    """One centred line built from (text, colour) pairs."""
    total = sum(width(t, cap, track) + track for t, _ in pairs) - track
    out, x = [], (box_w - total) / 2
    for t, c in pairs:
        d, w = glyphs(t, cap, track, x, cy_baseline)
        out.append(path(d, c))
        x += w + track
    return "\n".join(out)


def write(rel, text):
    p = os.path.join(RES, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w", encoding="utf-8", newline="\n").write(text)
    print("  ", rel)


# ---------------------------------------------------------------- banner
# 320x180 is the Android TV banner size. This is the ONLY thing the TV home
# row shows for the app, so it carries the wordmark, not an icon: at this
# size on a screen three metres away a symbol is a smudge and a word is not.
# Light field on purpose - the launcher背景 is near-black, and the old dark
# banner simply vanished into it.
BAR = 12
banner = "\n".join([
    rect(320, 180, LIGHT),
    centred([("KD", INK), ("TV", ACC)], 52, 3, 108, 320),
    rect(320, BAR, ACC, y=180 - BAR),
])
write("drawable/ic_banner.xml", vector(320, 180, banner, """
    Android TV 首页那一行显示的就是这张图（320x180）。

    用字不用图标：这一行的图块实际只有屏幕的十几分之一，三米外看，
    符号是一团糊，字还能读。浅底也是故意的 —— 电视首页背景接近纯黑，
    原先那张深色底的 banner 在里面基本看不见。

    字形是 Noto Sans Bold 转的轮廓（矢量图不能画文字），
    和电视界面自己用的是同一套字。改字请重跑 scripts/brand.py。"""))

# ------------------------------------------------------------ launcher
# Two rows so the wordmark survives being shrunk into a 48dp circle.
def stack(size, cap, gap, bg):
    rows = [[("KD", INK)], [("TV", ACC)]]
    block = len(rows) * cap + (len(rows) - 1) * gap
    top = (size - block) / 2
    body = [rect(size, size, bg)] if bg else []
    for i, r in enumerate(rows):
        body.append(centred(r, cap, 2, top + cap + i * (cap + gap), size))
    return "\n".join(body)


write("drawable/ic_launcher.xml", vector(108, 108, stack(108, 36, 6, LIGHT), """
    老系统（Android 8 以前）用的方形图标。
    电视桌面不看这张图 —— 它只出现在「设置 - 应用」里。"""))

# Adaptive icon: the system masks it to whatever shape the launcher wants, and
# only the middle 66 of 108 is guaranteed visible, so the wordmark is drawn
# smaller here than in the legacy icon above. The two files are not redundant.
write("drawable/ic_launcher_background.xml",
      vector(108, 108, rect(108, 108, LIGHT), "    自适应图标的底层。"))
write("drawable/ic_launcher_foreground.xml",
      vector(108, 108, stack(108, 24, 5, None), """
    自适应图标的前景。系统会按桌面的形状裁切，
    只有中间 66/108 这一块保证不被裁掉，所以字比方形图标那张小一圈。"""))
write("drawable-anydpi-v26/ic_launcher.xml",
      '<?xml version="1.0" encoding="utf-8"?>\n'
      '<!--\n    Android 8 以上用这张：系统按各家桌面的形状（圆/方/水滴）自己裁。\n-->\n'
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
      '    <background android:drawable="@drawable/ic_launcher_background" />\n'
      '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
      '</adaptive-icon>\n')
