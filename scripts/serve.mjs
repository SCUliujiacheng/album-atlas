import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript',
  '.css':'text/css','.json':'application/json','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml',
  '.md':'text/plain; charset=utf-8','.webmanifest':'application/manifest+json'};

export async function startServer({port = 4173, host = '127.0.0.1'} = {}) {
  const base = await realpath(root);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {Allow:'GET, HEAD'}).end(); return;
      }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const pieces = path.split(/[/\\]+/).filter(Boolean);
      if (pieces.some(s => s.startsWith('.') || s === 'node_modules')) throw new Error('hidden');
      const file = await realpath(resolve(base, ...pieces, ...(path.endsWith('/') ? ['index.html'] : [])));
      const rel = relative(base, file);
      if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(file)).isFile()) throw new Error('missing');
      res.writeHead(200, {'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':'no-cache',
        'X-Content-Type-Options':'nosniff'});
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = await startServer({port:Number(process.env.PORT || 4173)});
  console.log('Album Atlas is ready at http://127.0.0.1:' + server.address().port);
}
