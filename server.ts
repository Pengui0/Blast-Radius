import express from 'express';
import { createServer as createViteServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PYTHON_PORT = Number(process.env.API_PORT || 8001);
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

// ---- Python FastAPI backend (spawned unless you run it yourself: SKIP_PYTHON=1) -----------------
let pyProcess: ChildProcess | null = null;
function startPython() {
  if (process.env.SKIP_PYTHON === '1') return;
  pyProcess = spawn(PYTHON_BIN, ['-m', 'backend.main'], {
    stdio: 'inherit',
    env: { ...process.env, API_PORT: String(PYTHON_PORT) },
  });
  pyProcess.on('error', (err) => console.error(`[FastAPI] could not start "${PYTHON_BIN}": ${err.message}`));
  pyProcess.on('exit', (code, signal) => console.log(`[FastAPI] exited (code ${code}, signal ${signal})`));
}
function stopPython() {
  try {
    pyProcess?.kill();
  } catch {
    /* ignore */
  }
}
startPython();
process.on('exit', stopPython);
process.on('SIGINT', () => { stopPython(); process.exit(0); });
process.on('SIGTERM', () => { stopPython(); process.exit(0); });

// ---- /api -> FastAPI. Streams request and response untouched (works for POST bodies and SSE) -----
// There is deliberately NO canned fallback data here: if the backend is down the UI must say so.
app.use('/api', (req, res) => {
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: PYTHON_PORT,
      path: req.originalUrl,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${PYTHON_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(503).json({ error: 'backend_unavailable', detail: 'FastAPI backend is not reachable (still starting?)' });
    else res.end();
  });
  res.on('close', () => proxyReq.destroy()); // client went away (e.g. closed an SSE stream)
  req.pipe(proxyReq);
});

async function start() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => res.sendFile(path.resolve('dist', 'index.html')));
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Blast Radius] UI + API proxy on http://localhost:${PORT} (backend :${PYTHON_PORT})`);
  });
}
start();
