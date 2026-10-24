import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://localhost:5173';
const timeoutMs = 25_000;
const logs = [];
let child;
let socket;
let session;
let cleaned = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function logLine(source, chunk) {
  const text = String(chunk).trim();
  if (text) logs.push(`[${source}] ${text}`);
  while (logs.length > 60) logs.shift();
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitForHttp(base, path, timeout = timeoutMs) {
  const end = Date.now() + timeout;
  let lastError = 'not reached';
  while (Date.now() < end) {
    try {
      const res = await fetch(base + path, { headers: { origin }, signal: AbortSignal.timeout(5_000) });
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${path}: ${lastError}`);
}
async function request(base, path, { method = 'GET', body, token } = {}) {
  const headers = { origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  return { res, data, raw };
}
const messages = [];
function parseMessage(raw) {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}
async function waitMessage(predicate, from = 0, timeout = timeoutMs, label = 'message') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = messages.slice(from).find(item => item && predicate(item));
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for WebSocket ${label}. Recent messages: ${JSON.stringify(messages.slice(-5).map(m => m?.type))}`);
}
async function waitSessionUrl(base, id, token, suffix, timeout = timeoutMs) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    const result = await request(base, `/api/session/${id}`, { token });
    if (result.res.ok) {
      last = result.data;
      const tab = (last.tabs || []).find(t => t.id === last.activeTabId);
      if (tab?.url?.includes(suffix)) return { session: last, tab };
    }
    await sleep(100);
  }
  throw new Error(`Remote tab did not reach URL fragment ${suffix}. Last session state: ${JSON.stringify(last)}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function closeEverything() {
  if (cleaned) return;
  cleaned = true;
  try {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
  } catch {}
  try {
    if (session?.id && session?.token && child?.exitCode === null) {
      await request(baseUrl, `/api/session/${session.id}`, { method: 'DELETE', token: session.token }).catch(() => {});
    }
  } catch {}
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(4_000)
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
let baseUrl;

try {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ALLOWED_ORIGINS: origin,
      MAX_SESSIONS: '1',
      MAX_TABS: '3',
      SESSION_TTL_MS: '90000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => logLine('backend', chunk));
  child.stderr.on('data', chunk => logLine('backend-error', chunk));
  child.once('exit', code => { if (!cleaned) logLine('backend-exit', `exit code ${code}`); });

  await waitForHttp(baseUrl, '/healthz');
  console.log('PASS backend startup and liveness');

  const health = await request(baseUrl, '/health');
  assert(health.res.status === 200 && health.data.browser === 'connected', `Browser health failed: HTTP ${health.res.status} ${health.raw}`);
  console.log('PASS /health launches and checks the browser runtime');

  const browserHealth = await request(baseUrl, '/health/browser');
  assert(browserHealth.res.status === 200 && browserHealth.data.title, `Browser website health failed: HTTP ${browserHealth.res.status} ${browserHealth.raw}`);
  console.log('PASS /health/browser loads a real public webpage');

  const created = await request(baseUrl, '/api/session', { method: 'POST', body: {} });
  assert(created.res.status === 201 && created.data.id && created.data.token && created.data.activeTabId, `Session create failed: HTTP ${created.res.status} ${created.raw}`);
  session = created.data;
  const { id, token, activeTabId } = session;
  console.log('PASS secure browser session created');

  // The local test owns this server and sets MAX_SESSIONS=1. Test capacity here
  // rather than opening an extra public-production session during parallel deploys.
  const saturated = await request(baseUrl, '/api/session', { method: 'POST', body: {} });
  if (saturated.res.status === 201 && saturated.data.id && saturated.data.token) {
    await request(baseUrl, `/api/session/${saturated.data.id}`, { method: 'DELETE', token: saturated.data.token }).catch(() => {});
  }
  assert(saturated.res.status === 503, `Session capacity was not enforced: HTTP ${saturated.res.status} ${JSON.stringify(saturated.data)}`);
  console.log('PASS concurrent session limit enforced');

  const unauthenticated = await request(baseUrl, `/api/session/${id}`);
  assert(unauthenticated.res.status === 401, `Session ownership check failed: HTTP ${unauthenticated.res.status}`);
  console.log('PASS session status is protected by ownership token');

  const wsUrl = `${baseUrl.replace(/^http:/, 'ws:')}/stream?sessionId=${encodeURIComponent(id)}`;
  socket = new WebSocket(wsUrl, { headers: { origin } });
  socket.on('message', raw => { const parsed = parseMessage(raw); if (parsed) messages.push(parsed); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connection timed out.')), 12_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  socket.send(JSON.stringify({ type: 'auth', token }));
  const ready = await waitMessage(m => m.type === 'ready', 0, 20_000, 'ready handshake');
  assert(ready.activeTabId === activeTabId, 'Viewer connected to an unexpected tab');
  console.log('PASS authenticated WebSocket viewer handshake');

  const navigate = async (url, pathSuffix = '') => {
    const cursor = messages.length;
    const result = await request(baseUrl, `/api/session/${id}/navigate`, { method: 'POST', token, body: { url } });
    assert(result.res.ok, `Navigation to ${url} failed: HTTP ${result.res.status} ${result.raw}`);
    const expected = new URL(url).href;
    await waitMessage(m => m.type === 'state' && m.tabId === activeTabId && (pathSuffix ? m.url?.includes(pathSuffix) : m.url === expected), cursor, 25_000, `navigation state for ${url}`);
    const frame = await waitMessage(m => m.type === 'frame' && m.tabId === activeTabId && typeof m.data === 'string' && m.data.length > 1000, cursor, 25_000, `live frame for ${url}`);
    const jpeg = Buffer.from(frame.data, 'base64');
    assert(jpeg.length > 1000 && jpeg[0] === 0xff && jpeg[1] === 0xd8, `Frame for ${url} was not JPEG image data`);
    return result.data;
  };

  await navigate('https://example.com/');
  console.log('PASS https://example.com loads and emits live browser frames');

  await navigate('https://playwright.dev/');
  console.log('PASS JavaScript-heavy public site navigation and rendering');

  const back = await request(baseUrl, `/api/sessions/${id}/tabs/${activeTabId}/back`, { method: 'POST', token, body: {} });
  assert(back.res.ok, `Back failed: HTTP ${back.res.status} ${back.raw}`);
  await waitSessionUrl(baseUrl, id, token, 'example.com');
  console.log('PASS browser back control');

  const forward = await request(baseUrl, `/api/sessions/${id}/tabs/${activeTabId}/forward`, { method: 'POST', token, body: {} });
  assert(forward.res.ok, `Forward failed: HTTP ${forward.res.status} ${forward.raw}`);
  await waitSessionUrl(baseUrl, id, token, 'playwright.dev');
  console.log('PASS browser forward control');

  const reload = await request(baseUrl, `/api/sessions/${id}/tabs/${activeTabId}/reload`, { method: 'POST', token, body: {} });
  assert(reload.res.ok, `Reload failed: HTTP ${reload.res.status} ${reload.raw}`);
  await waitSessionUrl(baseUrl, id, token, 'playwright.dev');
  console.log('PASS browser reload control');

  const invalid = await request(baseUrl, `/api/session/${id}/navigate`, { method: 'POST', token, body: { url: 'file:///etc/passwd' } });
  assert(invalid.res.status === 400, `Unsafe URL was not rejected: HTTP ${invalid.res.status} ${invalid.raw}`);
  console.log('PASS unsafe URL rejection');

  const beforeInput = messages.length;
  socket.send(JSON.stringify({ type: 'input', tabId: activeTabId, event: 'mouseMoved', x: 80, y: 80 }));
  socket.send(JSON.stringify({ type: 'input', tabId: activeTabId, event: 'mousePressed', x: 80, y: 80, button: 0 }));
  socket.send(JSON.stringify({ type: 'input', tabId: activeTabId, event: 'mouseReleased', x: 80, y: 80, button: 0 }));
  socket.send(JSON.stringify({ type: 'type', tabId: activeTabId, text: 'browse2browse-smoke' }));
  socket.send(JSON.stringify({ type: 'key', tabId: activeTabId, key: 'Enter', code: 'Enter', modifiers: {} }));
  await waitMessage(m => m.type === 'frame' && m.tabId === activeTabId, beforeInput, 8_000, 'viewer frame after pointer and keyboard events');
  console.log('PASS remote pointer and keyboard control messages are accepted');

  const closed = await request(baseUrl, `/api/session/${id}`, { method: 'DELETE', token });
  assert(closed.res.ok && closed.data.status === 'closed', `Session close failed: HTTP ${closed.res.status} ${closed.raw}`);
  session = null;
  console.log('PASS session closes through the owned-session API');
  console.log('E2E RESULT: PASS (local API + real Playwright browser + live CDP stream)');
} catch (error) {
  console.error('E2E RESULT: FAIL');
  console.error(String(error?.stack || error));
  if (logs.length) console.error('Recent backend logs:\n' + logs.slice(-35).join('\n'));
  process.exitCode = 1;
} finally {
  await closeEverything();
}
