import assert from 'node:assert/strict';

// Isolate capability failures from the ordinary browser journey and its clean-console assertion.
export async function verifyWorkerPaths(browser, origin) {
  for (const mode of ['worker', 'unsupported', 'no-offscreen', 'runtime-error', 'both-fail', 'visual']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      if (mode === 'unsupported') {
        await context.addInitScript(() => Object.defineProperty(window, 'Worker', { value: undefined }));
      }
      if (mode === 'no-offscreen') {
        const removeOffscreen = () => Object.defineProperty(globalThis, 'OffscreenCanvas', { value: undefined });
        await context.addInitScript(removeOffscreen);
        await context.route('**/src/embed-worker.js', async route => {
          const response = await route.fetch();
          await route.fulfill({ response, body: '(' + removeOffscreen.toString() + ')();\n' + await response.text() });
        });
      }
      if (mode === 'runtime-error') {
        await context.route('**/src/embed-worker.js', route => route.fulfill({
          contentType: 'application/javascript', body: 'self.onmessage = () => { throw new Error("Test worker failure"); };',
        }));
      }
      if (mode === 'both-fail') {
        await context.route('**/vendor/mobilenet/model.json', route => route.fulfill({ status: 404, body: 'Test missing model' }));
      }
      const requests = [];
      context.on('request', request => {
        if (/^https?:/.test(request.url())) requests.push({ url: new URL(request.url()), method: request.method() });
      });
      const page = await context.newPage();
      const workers = [];
      page.on('worker', worker => workers.push(worker.url()));
      await page.goto(origin);
      const result = await page.evaluate(async mode => {
        const { extractEmbedding, inferenceDiagnostics } = await import('./src/embedding.js');
        const images = [...document.querySelectorAll('.print img')];
        await Promise.all(images.map(img => img.decode()));
        if (mode === 'both-fail') {
          const soft = await extractEmbedding(images[0]);
          let rejected = false;
          try { await extractEmbedding(images[1], { requiredModel: true }); } catch { rejected = true; }
          return { kind: soft.kind, rejected, runtime: inferenceDiagnostics() };
        }
        // Multiple callers must receive their own vector, including when their
        // common worker dies and all pending requests retry on the main thread.
        const options = { forceVisual: mode === 'visual', requiredModel: mode !== 'visual' };
        const parallel = await Promise.all(images.map(img => extractEmbedding(img, options)));
        const serial = [];
        for (const img of images) serial.push((await extractEmbedding(img, options)).vector);
        return {
          kinds: parallel.map(r => r.kind), distinct: new Set(parallel.map(r => JSON.stringify(r.vector))).size,
          corresponding: parallel.every((r, i) => r.vector.every((v,j) => Math.abs(v-serial[i][j]) < 1e-5)),
          mainLoadedTF: Boolean(globalThis.tf), runtime: inferenceDiagnostics(),
        };
      }, mode);
      assert.ok(requests.every(r => r.url.origin === origin && ['GET','HEAD'].includes(r.method)));
      assert.ok(workers.every(url => url === origin + '/src/embed-worker.js'));
      if (mode === 'both-fail') {
        assert.equal(result.kind, 'visual');
        assert.ok(result.rejected && result.runtime.workerFailure && result.runtime.modelError);
      } else {
        assert.equal(result.distinct, 3);
        assert.ok(result.corresponding);
        assert.ok(result.kinds.every(k => k === (mode === 'visual' ? 'visual' : 'mobilenet')));
        if (mode === 'visual') {
          assert.equal(result.mainLoadedTF, false);
          assert.equal(workers.length, 0);
        } else {
          assert.ok(['cpu','webgl'].includes(result.runtime.backend));
          assert.equal(result.mainLoadedTF, result.runtime.location === 'main');
          if (mode === 'worker') assert.equal(result.runtime.location, 'worker');
          if (mode === 'unsupported' || mode === 'runtime-error') {
            assert.equal(result.runtime.location, 'main');
            assert.ok(result.runtime.workerFailure);
          }
        }
      }
    } finally {
      await context.close();
    }
  }
}
