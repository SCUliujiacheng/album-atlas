"""Generate the reserved outdoor crop pairs and hard controls outside the checkout."""

import argparse
import hashlib
import io
import itertools
import json
import random
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance

SOURCE_LIST = Path(__file__).with_name("crop-eval-sources.json")
ARCHIVE_SHA = "e6157352dd9aeb055519be6afe1744bd20be9b2270bcb987f9dd06afb787f460"
LIST_SHA = "6fc53e6b7f442ac55cdd3d0b801938d170fd3043cf0ec8b85d2758a2b625d5ee"


def digest_of(content):
    return hashlib.sha256(content).hexdigest()


def prepare(data, out):
    if out.exists() and any(out.iterdir()):
        raise ValueError("Choose an empty destination directory.")
    archive = data / "spatial-envelope.zip"
    with archive.open("rb") as stream:
        archive_hash = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            archive_hash.update(chunk)
    reserved = SOURCE_LIST.read_bytes()
    if archive_hash.hexdigest() != ARCHIVE_SHA or digest_of(reserved) != LIST_SHA:
        raise ValueError(
            "The archive or reserved image list differs from the published study."
        )
    old = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    if len(old) != 200:
        raise ValueError(
            "Run scripts/prepare-scene-eval.py to build the original 200-row exclusion list."
        )
    oldnames = {Path(row["path"]).name for row in old}
    oldhashes = {digest_of((data / row["path"]).read_bytes()) for row in old}
    images = out / "fixtures"
    seen = set()
    originals = []
    cases = []
    geometry = {}

    def pair(a, b, f, expected):
        cases.append(dict(a=a, b=b, family=f, expected=expected))

    images.mkdir(parents=True)
    with zipfile.ZipFile(archive) as zipped:
        for i, r in enumerate(json.loads(reserved)):
            entry = r["zipEntry"]
            if Path(entry).name in oldnames:
                raise ValueError("Repeated filename in reserved split.")
            original = zipped.read(entry)
            digest = digest_of(original)
            if digest in oldhashes or digest in seen:
                raise ValueError("Reserved image overlaps an existing file.")
            seen.add(digest)
            name = f"held-{i:03d}"
            source = name + ".jpg"
            (images / source).write_bytes(original)
            originals.append(
                dict(
                    name=source,
                    label=r["label"],
                    sourceSha256=digest,
                    sourceEntry=entry,
                )
            )
            img = Image.open(io.BytesIO(original)).convert("RGB")
            # Same six scoring conditions transfer to new photos. The second block
            # varies geometry plus encoding/dimensions independently of the detector.
            fixed = [
                ("center-72", 0.72, 0.72, 0.5, 0.5),
                ("center-82", 0.82, 0.82, 0.5, 0.5),
                ("offcenter-69", 0.69, 0.69, 0.83, 0.14),
                ("offcenter-61", 0.61, 0.61, 0.18, 0.79),
                ("portrait", 0.61, 0.81, 0.34, 0.73),
                ("landscape", 0.81, 0.61, 0.72, 0.21),
            ]
            rng = random.Random(
                digest_of(("atlas-untouched-geometry-v1/" + Path(entry).name).encode())
            )
            extra = []
            for family, small, large, shape in [
                ("stress-center-low", 0.58, 0.72, "center"),
                ("stress-center-high", 0.76, 0.90, "center"),
                ("stress-offcenter-low", 0.57, 0.70, "offset"),
                ("stress-offcenter-high", 0.73, 0.88, "offset"),
                ("stress-portrait", 0.72, 0.86, "portrait"),
                ("stress-landscape", 0.72, 0.86, "landscape"),
            ]:
                s = rng.uniform(small, large)
                a = rng.uniform(0.69, 0.80)
                fw = s * (a if shape == "portrait" else 1)
                fh = s * (a if shape == "landscape" else 1)

                def side():
                    return (
                        rng.uniform(0.05, 0.35)
                        if rng.randrange(2)
                        else rng.uniform(0.65, 0.95)
                    )

                ox, oy = (0.5, 0.5) if shape == "center" else (side(), side())
                extra.append((family, fw, fh, ox, oy))
            for tag, fw, fh, ox, oy in fixed + extra:
                w, h = round(img.width * fw), round(img.height * fh)
                x, y = round((img.width - w) * ox), round((img.height - h) * oy)
                crop = img.crop((x, y, x + w, y + h))
                stress = tag.startswith("stress")
                crop = ImageEnhance.Contrast(crop).enhance(
                    rng.uniform(0.91, 1.10) if stress else 0.97
                )
                size = rng.choice([147, 169, 203, 221]) if stress else 196
                crop = crop.resize(
                    (round(size * w / max(w, h)), round(size * h / max(w, h))),
                    Image.Resampling.LANCZOS,
                )
                target = name + "-" + tag + ".jpg"
                crop.save(
                    images / target,
                    quality=rng.choice([60, 70, 81, 86]) if stress else 78,
                )
                geometry[target] = [
                    x / img.width,
                    y / img.height,
                    w / img.width,
                    h / img.height,
                ]
                pair(source, target, tag, True)
            for tag in ["bytes", "jpeg"]:
                target = name + "-" + tag + ".jpg"
                if tag == "bytes":
                    (images / target).write_bytes(original)
                else:
                    img.save(images / target, quality=38)
                pair(source, target, tag, True)
    for a, b in itertools.combinations(originals, 2):
        pair(
            a["name"],
            b["name"],
            "distinct same class"
            if a["label"] == b["label"]
            else "distinct across class",
            False,
        )
    for i in range(24):
        group = []
        for j, sign in enumerate([-1, 1]):
            graphic = Image.new("RGB", (160, 160))
            rgba = []
            for y in range(160):
                for x in range(160):
                    value = (
                        120
                        + (
                            ((x + 3 * i) // (8 + i % 9) + (y + 5) // (11 + i % 7)) % 3
                            - 1
                        )
                        * 29
                    )
                    rgba.append(
                        (value + sign * 39, value - sign * 15, value - sign * 24)
                    )
            graphic.putdata(rgba)
            target = f"held-color-{i:02d}-{j}.png"
            graphic.save(images / target)
            group.append(target)
        pair(*group, "distinct colorway", False)
        group = []
        for j in range(2):
            graphic = Image.new("RGB", (160, 160), "#cabca6")
            d = ImageDraw.Draw(graphic)
            d.rectangle((8, 8, 151, 151), fill="#4a383e", outline="#c89976", width=6)
            with Image.open(images / originals[2 * i + j]["name"]) as picture:
                graphic.paste(
                    picture.resize((122, 90), Image.Resampling.LANCZOS), (19, 22)
                )
            d.text((25, 124), "STUDY " + str(2 * i + j), fill="#f0dab7")
            target = f"held-frame-{i:02d}-{j}.png"
            graphic.save(images / target)
            group.append(target)
        pair(*group, "distinct framed scenes", False)
        with Image.open(images / originals[i]["name"]) as picture:
            card = picture.convert("RGB").resize((256, 256))
        d = ImageDraw.Draw(card)
        d.rectangle((59, 153, 191, 178), fill="#e3d9c4")
        d.text((65, 157), "PLATFORM 3: EAST", fill="#111515")
        a = f"held-notice-{i:02d}.png"
        card.save(images / a)
        crop = card.crop((35, 35, 221, 221))
        d = ImageDraw.Draw(crop)
        d.rectangle((24, 118, 156, 143), fill="#184539" if i % 2 == 0 else "#e3d9c4")
        d.text(
            (30, 122), "PLATFORM 8: WEST", fill="#f5ede8" if i % 2 == 0 else "#111515"
        )
        b = f"held-notice-{i:02d}-edited.jpg"
        crop.save(images / b, quality=82)
        pair(a, b, "cropped panel with changed notice", False)
    (out / "cases.json").write_text(
        json.dumps(dict(originals=originals, cases=cases)), encoding="utf8"
    )
    (out / "geometry.json").write_text(json.dumps(geometry), encoding="utf8")

    print(
        f"Generated {len(originals)} originals and {len(cases)} initial labeled pairs in {out}."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path, help="Output of prepare-scene-eval.py")
    parser.add_argument("out", type=Path, help="Empty local output directory")
    args = parser.parse_args()
    prepare(args.data, args.out)
