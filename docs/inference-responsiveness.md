# Can the page keep responding while it sorts photos?

On one Windows x64 machine running Chrome 156.0.8078.80, Album Atlas 1.1 paused a 20 ms page timer for about two seconds during its first WebGL import. Version 1.2 moves the learned model to a local dedicated worker. The median longest interruption during the same cold import dropped from **2,010 ms to 39 ms**.

With WebGL disabled, both releases used the real TensorFlow.js CPU backend. On a second, already-warm batch, the median within-run p95 heartbeat gap fell from **567 ms to 21 ms**. The twelve photos took about 6.7 seconds in either release.

## Results

Each cell is the median of three fresh-browser runs. Each run timed one twelve-photo batch with a cold model and then a second batch with the same model already loaded. Times are milliseconds. A heartbeat is a main-page `setInterval` callback scheduled every 20 ms.

| Actual backend / model state | Batch elapsed, v1.1 → v1.2 | Longest gap, v1.1 → v1.2 | p95 gap, v1.1 → v1.2 |
| --- | ---: | ---: | ---: |
| WebGL / cold | 2,706 → 2,814 | 2,010 → 39 | 47 → 21 |
| WebGL / warm | 372 → 472 | 27 → 29 | 23 → 27 |
| CPU / cold | 6,895 → 6,901 | 605 → 51 | 592 → 21 |
| CPU / warm | 6,670 → 6,663 | 579 → 26 | 567 → 21 |

The warm WebGL batch was **100 ms slower** with the worker on this machine. The model still has to compile and execute. Moving it off the main thread frees the page to paint progress and respond to scrolling during long computations. These timings measure event-loop availability on one browser and device. They do not measure frame rate, touch latency or general throughput across devices.

## What was compared

- The baseline server runs the actual, clean v1.1.0 checkout. The candidate runs its own server. Both import the same 12 bundled photographs via the normal `workflow.ingest` entry point. The files are in memory before timing starts. Measured work includes decoding, previews, feature extraction and copy evidence.
- The two version orders alternate between repetitions. The native-backend run requires WebGL. The CPU run denies WebGL context creation in the page and the dedicated worker, then verifies TensorFlow.js reports `cpu`. The script also verifies every photo used MobileNet and every network request observed was a same-origin GET.
- Each paired run compares the complete embedding of each photo, the top album suggestion and final assignment for six queries, and three-way visual cluster memberships. In all **12 paired comparisons**, vector coordinates were identical and decisions and cluster memberships matched. This comparison tests numerical parity on these images. It measures a different property from held-out recognition quality. [Recognition evaluation](model-evaluation.md)
- The report records both elapsed and first-photo times, counts of heartbeat gaps above 100/250 ms, every backend, decisions and per-pair vector differences. [Raw measurements](inference-responsiveness.json) · [Benchmark source](../scripts/benchmark-inference.mjs)

## Execution and fallback

The page uses its existing rasterizer and transfers an owned 224 × 224 RGBA buffer to a same-origin module worker. The worker executes the same graph and normalization, serializes access to the model and disposes its output tensor after reading it. The transferred buffer is detached from the page. One result vector comes back per request; the original file stays on the device. The local visual descriptor and thumbnail generation continue to run in the page.

A missing Worker API or a failed or unresponsive worker makes pending requests retry the learned model in the main page. The original decoded source is available to make a fresh raster after a failed transfer. WebGL is preferred and a CPU backend is available. The worker consumes `ImageData` and the fallback can use an ordinary HTML canvas. If learned inference fails in both locations, regular matching uses the visual-only descriptor and strict `requiredModel` callers receive an error. The service worker precaches the inference worker, shared runtime, graph and weights for subsequent offline visits.

## Reproduce

Use Node 22+ and a Chromium build with a usable WebGL backend. Install the app dependencies in the current checkout and create a separate worktree for the baseline. The recorded run used installed Chrome via `PLAYWRIGHT_CHANNEL=chrome`. The default uses Playwright’s managed Chromium.

```sh
npm ci
npx playwright install chromium
git worktree add --detach ../album-atlas-v1.1 5583e51885ac326eb46160eae898d0bb8a140cd0
node scripts/benchmark-inference.mjs ../album-atlas-v1.1 measurements.json
npm run test:browser
```

The browser suite also exercises concurrent requests, worker failure, missing Worker/OffscreenCanvas APIs, forced visual inference, strict failure and a real offline inference after installing the cache.
