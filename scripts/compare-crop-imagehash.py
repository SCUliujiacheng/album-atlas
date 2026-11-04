"""Run ImageHash's crop-resistant implementation on the same encoded files and pairs."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from importlib.metadata import version
import json
from pathlib import Path
from statistics import median

import imagehash
from PIL import Image


def encode(path):
    with Image.open(path) as source:
        return path.name, str(imagehash.crop_resistant_hash(source.convert("RGB")))


def box_iou(a, b):
    left, top = max(a[0], b[0]), max(a[1], b[1])
    w = max(0, min(a[0] + a[2], b[0] + b[2]) - left)
    h = max(0, min(a[1] + a[3], b[1] + b[3]) - top)
    intersection = w * h
    return intersection / (a[2] * a[3] + b[2] * b[3] - intersection)


def score(fixtures, evidence, geometry, workers):
    if version("ImageHash") != "4.3.2":
        raise RuntimeError(
            "Install ImageHash==4.3.2 to reproduce the pinned comparison."
        )
    names = sorted({row[key] for row in evidence for key in ("a", "b")})
    if any(Path(name).name != name for name in names):
        raise ValueError(
            "Fixture names must be filenames relative to the fixture directory."
        )
    with ProcessPoolExecutor(max_workers=workers) as pool:
        serialized = dict(
            pool.map(encode, (fixtures / name for name in names), chunksize=4)
        )
    bank = {
        name: imagehash.hex_to_multihash(value) for name, value in serialized.items()
    }
    counts = defaultdict(Counter)
    overlap, correct_side, accepted_crops = [], 0, 0
    decisions = []
    for row in evidence:
        a, b = bank[row["a"]], bank[row["b"]]
        # The user need not know which file is the original. Consider both
        # directions for region counts (the one-region default is symmetric).
        native = a.matches(b) or b.matches(a)
        stricter = a.matches(b, region_cutoff=2, hamming_cutoff=8) or b.matches(
            a, region_cutoff=2, hamming_cutoff=8
        )
        family = counts[row["family"]]
        family["pairs"] += 1
        family["expectedPositive"] += bool(row["expected"])
        family["imagehashDefault"] += bool(native)
        family["imagehashTwoRegionsEightBits"] += bool(stricter)
        family["atlasWholeFrame"] += bool(row["baseline"])
        family["atlasCombined"] += bool(row["baseline"] or row["crop"])
        if row["expected"] and row["crop"] and row["b"] in geometry:
            accepted_crops += 1
            if row["crop"]["originalId"] == row["a"]:
                correct_side += 1
                overlap.append(box_iou(row["crop"]["box"], geometry[row["b"]]))
        decisions.append(
            {
                **row,
                "imagehashDefault": native,
                "imagehashTwoRegionsEightBits": stricter,
            }
        )
    return {
        "imagehashVersion": version("ImageHash"),
        "pillowVersion": version("Pillow"),
        "uniqueEncodedFiles": len(names),
        "pairs": len(evidence),
        "cropLocalization": {
            "accepted": accepted_crops,
            "correctContainer": correct_side,
            "medianIoUOnCorrectContainer": median(overlap) if overlap else None,
        },
        "families": dict(sorted(counts.items())),
    }, decisions


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture_directory", type=Path)
    parser.add_argument(
        "browser_evidence",
        type=Path,
        help="JSON from the browser replay with a rows array",
    )
    parser.add_argument("--workers", type=int, default=4, choices=range(1, 17))
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--pairs-out", type=Path, help="Optional per-pair decisions and region evidence"
    )
    args = parser.parse_args()
    evidence = json.loads(args.browser_evidence.read_text(encoding="utf-8"))
    geometry_file = args.fixture_directory.parent / "geometry.json"
    geometry = json.loads(geometry_file.read_text(encoding="utf-8"))
    result, decisions = score(
        args.fixture_directory, evidence["rows"], geometry, args.workers
    )
    result["browser"] = evidence["browser"]
    if args.pairs_out:
        args.pairs_out.write_text(json.dumps(decisions) + "\n", encoding="utf-8")
    report = json.dumps(result, indent=2) + "\n"
    if args.out:
        args.out.write_text(report, encoding="utf-8")
    print(report)
