"""Build the public four-photo crop tutorial. Requires Pillow 12.0.0; no downloads."""
import argparse
import hashlib
import io
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "crop-practice.zip"
INPUT_DIGESTS = {
    "shore-03.jpg": "8a1627c4a8e57fb392356d92b068588cb4ff418090cf3a040247d35bd6a3b425",
    "forest-01.jpg": "4cfedcdcd62ea3b56eac31f45d6ebd41936660eabb6029f7b4e41786498e50db",
}

GUIDE = """Album Atlas / 相册罗盘
四图裁剪练习 · Four-photo crop review

1. 解压 ZIP。打开相册罗盘，点击「选择我的照片」，只选这四张 JPG。
2. 在「裁剪对照」点击「查找裁剪候选」，打开每一对。先用「适应窗口」看构图，再用 100% 或 200% 看细节。
3. 海岸组是真实裁剪，森林组中间的标牌有一处变化。标记「已核看」后，四张图仍可正常导出。

1. Unzip this pack. Open Album Atlas, choose “Choose my photos”, and select the four JPG files.
2. In “Crop comparisons”, choose “Find possible crops”. Open each pair. Start with Fit, then use 100% or 200% to read details.
3. The coast detail is a genuine crop. In the forest pair, inspect the small central plaque. Marking a pair reviewed leaves all four photos included in export.

对照答案 / Answer key
• 01 + 02: 02 is an off-center crop of 01, with no changed subject matter.
• 03 + 04: Both show the same forest composition. 03 says STATION 04; the cropped 04 says STATION 09. Keep both if the printed station matters.
• 01 + 02：取景变化，内容未改。03 + 04：原图写着 STATION 04，裁剪版写着 STATION 09。
These are designed teaching examples, separate from the evaluation benchmark.
这是刻意制作的练习材料，不计入识别能力的基准评测。

照片来源和许可 / Sources and license
01 / 02 · Rocky coast 1 (Unsplash) — Phil Evans (perthhealthcoach)
https://commons.wikimedia.org/wiki/File:Rocky_coast_1_%28Unsplash%29.jpg
03 / 04 · Sun's rays in a dense forest (Unsplash) — Filip Varga (vargafilip123)
https://commons.wikimedia.org/wiki/File:Sun%27s_rays_in_a_dense_forest_%28Unsplash%29.jpg
Both source photographs are CC0 1.0 Universal. The distributed Album Atlas source JPEGs were resized and stripped of metadata. This pack adds crops and a fictional printed station plaque; no sign has been attributed to the photographed location.
Creative Commons CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/
相片原作均采用 CC0 1.0。练习基于随应用分发的缩小版，另作裁剪并添加虚构标牌。
The added graphic and instructions are published under the repository's MIT license.
"""


def source(name):
    raw = (ROOT / "assets" / "demo" / name).read_bytes()
    if hashlib.sha256(raw).hexdigest() != INPUT_DIGESTS[name]:
        raise ValueError("Bundled practice source changed: " + name)
    return raw


def jpg(image):
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=90, subsampling=0, optimize=False, progressive=False)
    return output.getvalue()


def crop_region(image, x, y):
    """Fractional, off-center 50/64 crop in displayed-image coordinates."""
    width, height = image.size
    return image.crop(tuple(round(v) for v in (
        width*x/64, height*y/64, width*(x+50)/64, height*(y+50)/64)))


def station(image, number):
    out = image.copy()
    draw = ImageDraw.Draw(out)
    left, top = 400, 242
    draw.rounded_rectangle((left, top, left+143, top+56), radius=3,
                           fill="#f1ecda", outline="#293b37", width=2)
    draw.rectangle((left+5, top+5, left+8, top+51), fill="#ad6543")
    draw.text((left+16, top+7), "FIELD  /  STUDY", font=ImageFont.load_default(size=11), fill="#53615b")
    draw.text((left+15, top+23), "STATION " + number, font=ImageFont.load_default(size=21), fill="#203b37")
    return out


def make_pack():
    coast_bytes = source("shore-03.jpg")
    with Image.open(io.BytesIO(coast_bytes)) as coast, Image.open(io.BytesIO(source("forest-01.jpg"))) as forest:
        photos = [
            ("01-coast-full.jpg", coast_bytes),
            ("02-coast-detail.jpg", jpg(crop_region(coast, 4, 11))),
            ("03-forest-full.jpg", jpg(station(forest, "04"))),
            ("04-forest-detail.jpg", jpg(crop_region(station(forest, "09"), 7, 7))),
        ]
    output = io.BytesIO()
    instructions = GUIDE + "\n" + (ROOT / "LICENSE").read_text(encoding="utf-8").strip() + "\n"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, contents in [*photos, ("START-HERE.txt", instructions.encode("utf-8-sig"))]:
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, contents)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true", help="compare with an existing pack")
    args = parser.parse_args()
    content = make_pack()
    if args.check:
        if args.out.read_bytes() != content:
            raise SystemExit("The existing pack differs from this build.")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(content)
    print(f"{args.out.name}: {len(content):,} bytes, SHA-256 {hashlib.sha256(content).hexdigest()}")


if __name__ == "__main__":
    main()
