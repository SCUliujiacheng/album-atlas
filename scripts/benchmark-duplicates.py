"""Compare released ImageHash dHash with the shipped browser copy matcher on identical encoded inputs."""
import argparse
import itertools
import json
import shutil
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path
import imagehash
from PIL import Image, ImageEnhance, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def sources(scene_data):
    if not scene_data:
        return sorted((ROOT / 'assets/demo').glob('*.jpg'))
    manifest = json.loads((scene_data / 'manifest.json').read_text(encoding='utf8'))
    selected = []
    for label in ['coast', 'forest', 'insidecity', 'mountain']:
        rows = [r for r in manifest if r['label'] == label and r['split'] == 'test']
        selected.extend(scene_data / r['path'] for r in rows[:12])
    if len(selected) != 48:
        raise ValueError('Expected 48 photos from the prepared scene collection.')
    return selected


def fixtures(out, photos):
    cases, originals = [], []
    def case(a, b, family, expected):
        cases.append(dict(a=a, b=b, family=family, expected=expected))
    for i, source in enumerate(photos):
        prefix = f'photo-{i:03d}'
        name = prefix + '.jpg'
        shutil.copyfile(source, out / name)
        originals.append(name)
        with Image.open(source) as raw:
            img = ImageOps.exif_transpose(raw).convert('RGB')
            for tag in ['bytes', 'resize', 'jpeg', 'contrast', 'crop']:
                target = prefix + '-' + tag + '.jpg'
                if tag == 'bytes':
                    shutil.copyfile(source, out / target)
                elif tag == 'resize':
                    img.resize((max(1,img.width//2),max(1,img.height//2)), Image.Resampling.LANCZOS).save(out / target,quality=82)
                elif tag == 'jpeg':
                    img.save(out / target,quality=35)
                elif tag == 'contrast':
                    ImageEnhance.Contrast(img).enhance(1.18).save(out / target,quality=85)
                else:
                    margin_x, margin_y = img.width//7, img.height//7
                    img.crop((margin_x,margin_y,img.width-margin_x,img.height-margin_y)).save(out / target,quality=85)
                case(name,target,tag,True)
    for a,b in itertools.combinations(originals,2):
        case(a,b,'independent originals',False)
    # Paired graphics with a deliberately different colorway and the same layout.
    # Offsets preserve Pillow's grayscale response within rounding.
    for i in range(12):
        pair = []
        for direction in [-1,1]:
            canvas = Image.new('RGB',(128,128))
            pixels = []
            for y in range(128):
                for x in range(128):
                    light = 70 + 32*((x//(8+i))%3) + 35*((y//(10+i))%2)
                    pixels.append((light+direction*35,light-direction*11,light-direction*35))
            canvas.putdata(pixels)
            name = f'color-{i}-{direction}.png'
            canvas.save(out / name)
            pair.append(name)
        case(*pair,'distinct colorway controls',False)
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene-data',type=Path)
    parser.add_argument('--json',type=Path,help='Optional per-pair result file')
    args = parser.parse_args()
    if imagehash.__version__ != '4.3.2':
        raise RuntimeError('Install ImageHash==4.3.2 for this comparison.')
    with tempfile.TemporaryDirectory(prefix='atlas-copy-bench-') as temporary:
        out = Path(temporary)
        cases = fixtures(out,sources(args.scene_data))
        (out/'cases.json').write_text(json.dumps(cases),encoding='utf8')
        subprocess.run(['node',str(ROOT/'scripts/benchmark-duplicates.mjs'),str(out)],check=True)
        atlas = json.loads((out/'atlas.json').read_text(encoding='utf8'))
        hashes = {}
        for name in {c[k] for c in cases for k in ('a','b')}:
            with Image.open(out/name) as image:
                hashes[name] = imagehash.dhash(ImageOps.exif_transpose(image),hash_size=8)
        summary = defaultdict(lambda: {'pairs':0,'atlasFlags':0,'dhash5Flags':0,'dhash0Flags':0})
        for case, decision in zip(cases,atlas,strict=True):
            distance = int(hashes[case['a']] - hashes[case['b']])
            case.update(atlas=decision,dhashDistance=distance)
            row = summary[case['family']]
            row['pairs'] += 1
            row['atlasFlags'] += int(decision is not None)
            row['dhash5Flags'] += int(distance<=5)
            row['dhash0Flags'] += int(distance==0)
        print(json.dumps(summary, indent=2))
        if args.json:
            args.json.write_text(json.dumps({'summary':summary,'cases':cases},indent=2),encoding='utf8')


if __name__ == '__main__':
    main()
