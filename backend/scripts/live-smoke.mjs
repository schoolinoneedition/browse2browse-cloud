import WebSocket from 'ws';

const frontend = (process.env.B2B_FRONTEND_URL || 'https://browse2browse-cloud.onrender.com').replace(/\/$/, '');
const api = (process.env.B2B_API_URL || 'https://browse2browse-cloud-backend.onrender.com').replace(/\/$/, '');
const origin = new URL(frontend).origin;
const timeoutMs = 30_000;
const events = [];
let ws;
let session;
let sessionClosed = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(ok, message) { if (!ok) throw new Error(message); }
async function get(url, timeout=10_000) {
  return fetch(url, { headers: { origin }, signal: AbortSignal.timeout(timeout) });
}
async function apiRequest(path, { method='GET', body, token, timeout=30_000 }={}) {
  const headers = { origin };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(api + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  return { response, data, raw };
}
function parseMessage(raw) {
  try { return JSON.parse(raw.toString()); } catch { return null; }
}
async function waitMessage(predicate, from=0, timeout=timeoutMs, label='message') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = events.slice(from).find(item => item && predicate(item));
    if (found) return found;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}; recent viewer events: ${JSON.stringify(events.slice(-8).map(x=>x?.type))}`);
}
async function waitForPublicServices() {
  const end = Date.now() + 6 * 60_000;
  let last = {};
  while (Date.now() < end) {
    try {
      const [home, fixture, liveness, health] = await Promise.all([
        get(frontend + '/', 8_000),
        get(frontend + '/smoke-fixture.html', 8_000),
        get(api + '/healthz', 8_000),
        get(api + '/health', 8_000)
      ]);
      const homeText = home.ok ? await home.text() : '';
      const fixtureText = fixture.ok ? await fixture.text() : '';
      last = {
        frontend: home.status,
        fixture: fixture.status,
        backendLiveness: liveness.status,
        backendHealth: health.status
      };
      if (home.ok && homeText.includes('Browse2Browse Cloud') && homeText.includes('app.js?v=10')
        && fixture.ok && fixtureText.includes('Remote Browser Test')
        && liveness.ok && health.ok) return;
    } catch (error) {
      last = { error: String(error?.message || error) };
    }
    await sleep(10_000);
  }
  throw new Error(`Public Render services did not become ready within six minutes: ${JSON.stringify(last)}`);
}
async function waitSessionUrl(id, token, suffix, timeout=timeoutMs) {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    const state = await apiRequest(`/api/session/${id}`, { token, timeout: 8_000 });
    if (state.response.ok) {
      last = state.data;
      const tab = (last.tabs || []).find(item => item.id === last.activeTabId);
      if (tab?.url?.includes(suffix)) return { state: last, tab };
    }
    await sleep(100);
  }
  throw new Error(`Session did not reach ${suffix}; last state: ${JSON.stringify(last)}`);
}
async function openSocket(id, token) {
  const url = `${api.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/stream?sessionId=${encodeURIComponent(id)}`;
  const next = new WebSocket(url, { headers: { origin } });
  next.on('message', raw => { const message = parseMessage(raw); if (message) events.push(message); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Viewer WebSocket connection timed out.')), 15_000);
    next.once('open', () => { clearTimeout(timer); resolve(); });
    next.once('error', error => { clearTimeout(timer); reject(error); });
  });
  next.send(JSON.stringify({ type: 'auth', token }));
  const ready = await waitMessage(message => message.type === 'ready', events.length, 20_000, 'authenticated viewer ready');
  assert(ready.activeTabId, 'Ready handshake did not include an active browser tab.');
  ws = next;
  return ready;
}
async function navigate(id, token, tabId, url) {
  const start = events.length;
  const result = await apiRequest(`/api/session/${id}/navigate`, { method: 'POST', token, body: { url } });
  assert(result.response.ok, `Navigation failed for ${url}: HTTP ${result.response.status} ${result.raw}`);
  const expected = new URL(url).href;
  await waitMessage(m => m.type === 'state' && m.tabId === tabId && m.url === expected, start, 25_000, `navigation state ${expected}`);
  // Frames may arrive before the HTTP navigation request returns; use the
  // cursor captured before navigation so the test never misses a valid keyframe.
  const frame = await waitMessage(m => m.type === 'frame' && m.tabId === tabId && typeof m.data === 'string' && m.data.length > 1000, start, 25_000, `live frame for ${expected}`);
  const bytes = Buffer.from(frame.data, 'base64');
  assert(bytes.length > 1000 && bytes[0] === 0xff && bytes[1] === 0xd8, `Viewer did not deliver a JPEG browser frame for ${expected}`);
  return result.data;
}
async function pointer(tabId, event, x, y, extra={}) {
  assert(ws && ws.readyState === WebSocket.OPEN, 'Viewer socket is not connected.');
  ws.send(JSON.stringify({ type: 'input', tabId, event, x, y, ...extra }));
}
async function cleanup() {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
  try {
    if (session && session.id && session.token && !sessionClosed) {
      await apiRequest(`/api/session/${session.id}`, { method:'DELETE', token:session.token, timeout:10_000 });
      sessionClosed = true;
    }
  } catch {}
}

try {
  console.log('WAIT Render frontend and browser backend');
  await waitForPublicServices();
  console.log('PASS public frontend, test fixture, backend liveness and browser readiness');

  const browserHealth = await apiRequest('/health/browser', { timeout: 20_000 });
  assert(browserHealth.response.ok && browserHealth.data.title?.includes('Example Domain'),
    `Browser network probe failed: HTTP ${browserHealth.response.status} ${browserHealth.raw}`);
  console.log('PASS browser health endpoint opened a real public webpage');

  const created = await apiRequest('/api/session', { method:'POST', body:{}, timeout:90_000 });
  assert(created.response.status === 201 && created.data.id && created.data.token && created.data.activeTabId,
    `Could not create remote browser session: HTTP ${created.response.status} ${created.raw}`);
  session = created.data;
  const { id, token, activeTabId } = session;
  console.log('PASS remote session created');

  const ready = await openSocket(id, token);
  assert(ready.activeTabId === activeTabId, 'Viewer was attached to the wrong active tab.');
  console.log('PASS authenticated live viewer WebSocket');

  await navigate(id, token, activeTabId, 'https://example.com/');
  console.log('PASS example.com loaded in the remote browser with real live frames');

  await navigate(id, token, activeTabId, 'https://playwright.dev/');
  console.log('PASS JavaScript-heavy public site navigated and rendered');

  let result = await apiRequest(`/api/sessions/${id}/tabs/${activeTabId}/back`, { method:'POST', token, body:{} });
  assert(result.response.ok, `Back failed: HTTP ${result.response.status} ${result.raw}`);
  await waitSessionUrl(id, token, 'example.com');
  console.log('PASS browser back');

  result = await apiRequest(`/api/sessions/${id}/tabs/${activeTabId}/forward`, { method:'POST', token, body:{} });
  assert(result.response.ok, `Forward failed: HTTP ${result.response.status} ${result.raw}`);
  await waitSessionUrl(id, token, 'playwright.dev');
  console.log('PASS browser forward');

  result = await apiRequest(`/api/sessions/${id}/tabs/${activeTabId}/reload`, { method:'POST', token, body:{} });
  assert(result.response.ok, `Reload failed: HTTP ${result.response.status} ${result.raw}`);
  await waitSessionUrl(id, token, 'playwright.dev');
  console.log('PASS browser reload');

  const fixtureUrl = frontend + '/smoke-fixture.html';
  await navigate(id, token, activeTabId, fixtureUrl);
  console.log('PASS public input/scroll test page loaded');

  // The fixture puts the input at (20,20)-(300,58), and button at (20,72)-(160,110).
  await pointer(activeTabId, 'mouseMoved', 90, 38);
  await pointer(activeTabId, 'mousePressed', 90, 38, { button:0 });
  await pointer(activeTabId, 'mouseReleased', 90, 38, { button:0 });
  await sleep(250);
  ws.send(JSON.stringify({ type:'type', tabId:activeTabId, text:'b2b-live-smoke' }));
  await sleep(350);
  await pointer(activeTabId, 'mouseMoved', 90, 88);
  await pointer(activeTabId, 'mousePressed', 90, 88, { button:0 });
  await pointer(activeTabId, 'mouseReleased', 90, 88, { button:0 });
  await waitSessionUrl(id, token, '#interaction-b2b-live-smoke', 15_000);
  console.log('PASS mouse click and keyboard typing changed the actual browser page');

  await pointer(activeTabId, 'wheel', 850, 500, { deltaX:0, deltaY:1000 });
  await waitSessionUrl(id, token, '#scrolled-', 15_000);
  console.log('PASS scrolling changed the live browser page state');

  const invalid = await apiRequest(`/api/session/${id}/navigate`, { method:'POST', token, body:{ url:'file:///etc/passwd' } });
  assert(invalid.response.status === 400, `Unsafe URL was not rejected: HTTP ${invalid.response.status}`);
  console.log('PASS unsafe address rejected by backend');

  ws.close();
  ws = null;
  await waitSessionUrl(id, token, 'scrolled-', 8_000);
  const reconnectStart = events.length;
  await openSocket(id, token);
  await waitMessage(m => m.type === 'frame' && m.tabId === activeTabId && m.data?.length > 1000, reconnectStart, 10_000, 'frame after viewer reconnect');
  console.log('PASS viewer reconnected to the existing session');

  const closed = await apiRequest(`/api/session/${id}`, { method:'DELETE', token });
  assert(closed.response.ok && closed.data.status === 'closed', `Session close failed: HTTP ${closed.response.status} ${closed.raw}`);
  sessionClosed = true;
  session = null;
  console.log('PASS session closed and cleaned up');
  console.log('LIVE RENDER RESULT: PASS');
} catch (error) {
  console.error('LIVE RENDER RESULT: FAIL');
  console.error(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  await cleanup();
}
