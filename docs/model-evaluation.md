# When should a photo go to the review tray?

Album Atlas uses example photos to rank personal albums. The first question is whether the closest album is correct. The second is whether a photo from an entirely different album gets filed anyway. We tested both on a fixed sample of outdoor scenes.

## Held-out results

The browser ranked **76 of 80** known-album photos correctly. With the review gate enabled, it filed **69 of 104** photos. Of these, **67** went into the correct album and **2** came from categories with no reference album. The remaining **35** went to review. Automatic assignment precision was **67/69 (97.1%)**, with coverage of **69/104 (66.3%)**. Two of 24 unseen-category photos slipped through (**8.3%**).

| Held-out scene | Photos | Correct nearest suggestion | Correctly filed | Wrongly filed | Left for review |
| --- | ---: | ---: | ---: | ---: | ---: |
| Coast | 20 | 20 | 18 | 0 | 2 |
| Forest | 20 | 17 | 14 | 0 | 6 |
| Inner city | 20 | 20 | 19 | 0 | 1 |
| Mountain | 20 | 19 | 16 | 0 | 4 |
| Highway, absent from albums | 12 | — | — | 1 | 11 |
| Open country, absent from albums | 12 | — | — | 1 | 11 |

The two false assignments were a highway scene filed under inner city and an open-country scene filed under mountain. Users can inspect and move any assigned photo before export. Small samples, four known outdoor labels and eight reference photos per label limit what this result can tell us about everyday phone libraries. People's identities, event dates, subjective themes, visual-only fallback and single-album acceptance were outside this evaluation.

## Data and model selection

The source was the Oliva–Torralba Spatial Envelope outdoor scene collection. We selected images by sorting a salted SHA-256 of each filename within its original class. All 200 selected JPEGs had distinct file hashes. The app's demonstration photos were outside this dataset. The preparation script fetches the original archive into a directory you choose. [Author's dataset page](https://people.csail.mit.edu/torralba/code/spatialenvelope/) · [Deterministic preparation](../scripts/prepare-scene-eval.py)

| Split | Reference labels | Known queries | Unseen queries |
| --- | ---: | ---: | ---: |
| Reference | 4 × 8 images | — | — |
| Calibration | Same 32 references | 4 × 12 | 2 × 8 |
| Test | Same 32 references | 4 × 20 | 2 × 12 |

We compared Google MobileNet feature-vector models on the calibration split, keeping the full frame to retain edge content. The input is RGB scaled to 224 × 224. A normalized learned embedding contributes 86% of cosine similarity and an 81-value descriptor of color, spatial layout, luminance and edge direction contributes 14%. An album receives 75% of its score from its two nearest examples and 25% from its centroid. Ranking is independent of filenames, EXIF, and album names.

For each model, we searched score cutoffs from 0.30 to 0.80 in steps of 0.05 and runner-up margins of 0.015, 0.03, 0.045, 0.06, 0.08, 0.10, 0.12 and 0.15. We maximized correct automatic assignments with at least 90% precision and at most two accepted unseen queries on calibration. Ties favored fewer errors, then a higher score cutoff. All three models returned the correct nearest label for all 48 known calibration scenes.

| Candidate | Correctly filed on calibration | Unseen filed | Score / margin at operating point |
| --- | ---: | ---: | --- |
| MobileNet V1, width 0.25 | 41 | 1 | 0.70 / 0.06 |
| MobileNet V2, width 0.50 | 38 | 1 | 0.50 / 0.12 |
| **MobileNet V2, width 1.00** | **45** | **2** | **0.50 / 0.10** |

The full-width model and the 0.50 / 0.10 thresholds were frozen before the held-out run. The release-bundle evaluation reproduced 45 correct and 2 erroneous automatic assignments on calibration. On the Windows Chrome test machine, the held-out run averaged 57 ms per photo across 136 photos, including image decoding, model initialization and classification. Hardware, browser and photo size affect this timing. The model assets total 8,912,168 bytes, with another 1,105,894 bytes for the runtime. [Model source and asset hashes](../THIRD_PARTY.md)

## Reproduce

With Node.js 22+ and Python 3 available, run from the repository root. Choose a data directory outside the repository. `BROWSER_CHANNEL=chrome` selects installed Google Chrome if desired.

```sh
npm ci
npx playwright install chromium
python scripts/prepare-scene-eval.py ../atlas-scene-data
node scripts/evaluate-scenes.mjs ../atlas-scene-data calibration
node scripts/evaluate-scenes.mjs ../atlas-scene-data test ../atlas-scene-data/predictions.json
```

The runner loads the bundled model in a real browser and exits if semantic inference fails. The optional JSON output contains the prediction, similarity, margin and review decision for every query. The source archive used for this run had SHA-256 `e6157352dd9aeb055519be6afe1744bd20be9b2270bcb987f9dd06afb787f460`.
