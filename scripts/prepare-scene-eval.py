"""Fetch an external scene sample for local evaluation. No photos are published."""
import argparse
import hashlib
import json
import shutil
import urllib.request
import zipfile
from pathlib import Path

SOURCE = 'https://people.csail.mit.edu/torralba/code/spatialenvelope/spatial_envelope_256x256_static_8outdoorcategories.zip'
KNOWN = ('coast', 'forest', 'insidecity', 'mountain')
UNSEEN = ('highway', 'opencountry')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    out = parser.parse_args().directory
    out.mkdir(exist_ok=True, parents=True)
    archive = out / 'spatial-envelope.zip'
    if not archive.exists():
        pending = archive.with_suffix('.part')
        with urllib.request.urlopen(SOURCE, timeout=90) as response, pending.open('wb') as target:
            shutil.copyfileobj(response, target)
        pending.replace(archive)
    rows = []
    with zipfile.ZipFile(archive) as zipped:
        for category in KNOWN + UNSEEN:
            candidates = [p for p in zipped.namelist() if Path(p).name.lower().startswith(category + '_') and p.lower().endswith('.jpg')]
            candidates.sort(key=lambda p: hashlib.sha256(('album-atlas-scene-v1/' + Path(p).name).encode()).digest())
            splits = [('reference', 8), ('calibration', 12), ('test', 20)] if category in KNOWN else [('calibration', 8), ('test', 12)]
            index = 0
            for split, count in splits:
                if len(candidates) < index + count:
                    raise ValueError(f'Too few files in {category}: {len(candidates)}')
                for item in candidates[index:index + count]:
                    name = Path(item).name
                    target = out / 'images' / name
                    target.parent.mkdir(exist_ok=True)
                    target.write_bytes(zipped.read(item))
                    rows.append({'path': 'images/' + name, 'label': category, 'split': split, 'known': category in KNOWN})
                index += count
    (out / 'manifest.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')
    print(f'{len(rows)} image records in {out / "manifest.json"}')


if __name__ == '__main__':
    main()
