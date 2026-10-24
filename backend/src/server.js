import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium } from 'playwright';
import { validateUrl } from './url-policy.js';

const PORT = Number(process.env.PORT || 10000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000);
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 1));
const MAX_TABS = Math.max(1, Number(process.env.MAX_TABS || 6));
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:5173,https://schoolinoneedition.github.io').split(',').map(x => x.trim()).filter(Boolean));
const sessions = new Map();
const rateBuckets = new Map();
let browserPromise = null;
const log = (event, data = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
const hashToken = value => crypto.createHash('sha256').update(value).digest();

function json(res, status, data, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extra
  });
  res.end(JSON.stringify(data));
}
function originAllowed(origin) { return !origin || allowedOrigins.has(origin); }
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('access-control-max-age', '600');
  }
}
function rateLimit(key, limit = 40, windowMs = 60_000) {
  const now = Date.now();
  let item = rateBuckets.get(key);
  if (!item || item.until <= now) { item = { count: 0, until: now + windowMs }; rateBuckets.set(key, item); }
  item.count++;
  return item.count <= limit;
}
async function readBody(req, maxBytes = 16_384) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Request body is too large.');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON request.'); }
}
async function ensureBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
      const attempts = [
        { label: 'bundled Chromium headless shell', options: { headless: true, args } },
        { label: 'Chromium new-headless channel', options: { headless: true, channel: 'chromium', args } }
      ];
      const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH;
      if (executablePath) attempts.unshift({
        label: 'configured system browser',
        options: { headless: true, executablePath, args }
      });

      const failures = [];
      for (const attempt of attempts) {
        try {
          log('browser_launch_attempt', { strategy: attempt.label });
          const browser = await chromium.launch({ ...attempt.options, timeout: 20_000 });
          log('browser_launch_ready', { strategy: attempt.label });
          browser.on('disconnected', () => {
            log('browser_disconnected');
            browserPromise = null;
          });
          return browser;
        } catch (error) {
          const detail = String(error?.message || error).slice(0, 220);
          failures.push(`${attempt.label}: ${detail}`);
          log('browser_launch_failed', { strategy: attempt.label, error: detail });
        }
      }
      throw Object.assign(new Error(`Unable to start Chromium after ${attempts.length} launch strategies. ${failures.join(' | ')}`), { statusCode: 503 });
    })().catch(error => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}
function safeCompare(a, b) {
  const digest = hashToken(String(b || ''));
  return a && a.length === digest.length && crypto.timingSafeEqual(a, digest);
}
function authenticate(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(req.headers.authorization || '');
  if (!match) return null;
  for (const session of sessions.values()) {
    if (safeCompare(session.tokenHash, match[1])) { session.lastSeen = Date.now(); return session; }
  }
  return null;
}
function requireOwnedSession(req, id) {
  const session = authenticate(req);
  if (!session) throw Object.assign(new Error('Session expired. Start a new browser session.'), { statusCode: 401 });
  if (session.id !== id) throw Object.assign(new Error('Session access denied.'), { statusCode: 403 });
  return session;
}
function stateOf(tab) {
  return {
    type: 'state', tabId: tab.id,
    url: tab.page.url() === 'about:blank' ? '' : tab.page.url(),
    title: (tab.title || 'New tab').slice(0, 300), loading: !!tab.loading,
    canGoBack: !!tab.canGoBack, canGoForward: !!tab.canGoForward
  };
}
function snapshot(tab) {
  return { id: tab.id, url: tab.page.url() === 'about:blank' ? '' : tab.page.url(), title: tab.title || 'New tab', loading: !!tab.loading, canGoBack: !!tab.canGoBack, canGoForward: !!tab.canGoForward };
}
function emit(session, message) {
  const data = JSON.stringify(message);
  for (const peer of session.peers) if (peer.readyState === WebSocket.OPEN && peer.authenticated) peer.send(data);
}
async function updateTab(tab, loading = undefined) {
  if (tab.page.isClosed()) return;
  tab.title = (await tab.page.title().catch(() => '')).slice(0, 300) || new URL(tab.page.url()).hostname || 'New tab';
  if (loading !== undefined) tab.loading = loading;
  if (tab.cdp) {
    const history = await tab.cdp.send('Page.getNavigationHistory').catch(() => null);
    if (history) {
      tab.canGoBack = history.currentIndex > 0;
      tab.canGoForward = history.currentIndex >= 0 && history.currentIndex < history.entries.length - 1;
    }
  }
  emit(tab.session, stateOf(tab));
}
function finishNavigation(tab) {
  if (tab.navigationTimer) clearTimeout(tab.navigationTimer);
  tab.navigationTimer = null;
  updateTab(tab, false).catch(() => {});
}
function attachNavigationEvents(tab) {
  tab.page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === tab.page.mainFrame()) {
      if (tab.navigationTimer) clearTimeout(tab.navigationTimer);
      tab.loading = true;
      // A site may never dispatch load when a tracker hangs. Keep the visible page usable.
      tab.navigationTimer = setTimeout(() => finishNavigation(tab), 15_000);
      tab.navigationTimer.unref?.();
      emit(tab.session, stateOf(tab));
    }
  });
  // Update the address as soon as the main frame changes, but don't require every
  // resource or tracker to finish before considering a committed document usable.
  tab.page.on('framenavigated', frame => {
    if (frame === tab.page.mainFrame()) updateTab(tab, tab.loading).catch(() => {});
  });
  tab.page.on('domcontentloaded', () => finishNavigation(tab));
  tab.page.on('load', () => finishNavigation(tab));
  tab.page.on('close', () => {
    if (tab.navigationTimer) clearTimeout(tab.navigationTimer);
    if (tab.screenshotTimer) clearInterval(tab.screenshotTimer);
    const session = tab.session;
    session.tabs.delete(tab.id);
    if (session.activeTabId === tab.id) {
      session.activeTabId = session.tabs.keys().next().value || null;
      const next = session.activeTabId && session.tabs.get(session.activeTabId);
      if (next) startStream(session, next).catch(() => {});
    }
  });
}
async function registerPage(session, page) {
  if ([...session.tabs.values()].some(tab => tab.page === page)) return [...session.tabs.values()].find(tab => tab.page === page);
  if (session.tabs.size >= MAX_TABS) { await page.close().catch(() => {}); return null; }
  const tab = { id: crypto.randomUUID(), page, title: 'New tab', loading: false, canGoBack: false, canGoForward: false, cdp: null, session, navigationTimer: null, screenshotTimer: null, screenshotInFlight: false, lastCdpFrameAt: 0 };
  session.tabs.set(tab.id, tab);
  page.setDefaultNavigationTimeout(25_000);
  attachNavigationEvents(tab);
  page.on('popup', popup => registerPage(session, popup).then(result => result && startStream(session, result)).catch(() => {}));
  await updateTab(tab, false);
  return tab;
}
async function createTab(session) {
  if (session.tabs.size >= MAX_TABS) throw new Error(`This browser supports up to ${MAX_TABS} tabs per session.`);
  const page = await session.context.newPage();
  return registerPage(session, page);
}
async function stopStream(tab) {
  if (tab?.screenshotTimer) {
    clearInterval(tab.screenshotTimer);
    tab.screenshotTimer = null;
  }
  if (tab?.cdp) await tab.cdp.send('Page.stopScreencast').catch(() => {});
}
function startScreenshotFallback(tab) {
  if (tab.screenshotTimer) clearInterval(tab.screenshotTimer);
  tab.screenshotTimer = setInterval(async () => {
    if (tab.page.isClosed() || tab.session.activeTabId !== tab.id || tab.screenshotInFlight) return;
    if (tab.lastCdpFrameAt && Date.now() - tab.lastCdpFrameAt < 2_500) return;
    tab.screenshotInFlight = true;
    try {
      const image = await tab.page.screenshot({ type: 'jpeg', quality: 68, timeout: 5_000 });
      const viewport = tab.page.viewportSize() || { width: 1280, height: 800 };
      emit(tab.session, {
        type: 'frame', tabId: tab.id, data: image.toString('base64'),
        width: viewport.width, height: viewport.height, fallback: true
      });
    } catch (error) {
      log('screenshot_fallback_failed', { tabId: tab.id, error: String(error?.message || error).slice(0, 140) });
    } finally {
      tab.screenshotInFlight = false;
    }
  }, 1_200);
  tab.screenshotTimer.unref?.();
}
async function startStream(session, tab) {
  if (!tab || tab.page.isClosed()) return;
  const previous = session.tabs.get(session.activeTabId);
  if (previous && previous.id === tab.id && tab.cdp) {
    startScreenshotFallback(tab);
    await updateTab(tab);
    return;
  }
  if (previous && previous.id !== tab.id) await stopStream(previous);
  session.activeTabId = tab.id;

  try {
    if (!tab.cdp) {
      tab.cdp = await session.context.newCDPSession(tab.page);
      tab.cdp.on('Page.screencastFrame', async frame => {
        tab.lastCdpFrameAt = Date.now();
        if (session.activeTabId === tab.id) {
          emit(session, { type: 'frame', tabId: tab.id, data: frame.data, width: frame.metadata?.deviceWidth, height: frame.metadata?.deviceHeight });
        }
        await tab.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      });
      await tab.cdp.send('Page.enable');
    }
    await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 });
  } catch (error) {
    log('cdp_screencast_unavailable', { tabId: tab.id, error: String(error?.message || error).slice(0, 180) });
  }
  // If CDP screencasting is unavailable or stops emitting, continue with real page
  // screenshots instead of leaving the viewer on a permanent blank screen.
  startScreenshotFallback(tab);
  await updateTab(tab);
}
async function createSession() {
  if (sessions.size >= MAX_SESSIONS) throw Object.assign(new Error('The remote browser is at capacity. Close another session or try again later.'), { statusCode: 503 });
  const browser = await ensureBrowser();
  const token = crypto.randomBytes(32).toString('base64url');
  const session = {
    id: crypto.randomUUID(), tokenHash: hashToken(token), createdAt: Date.now(), lastSeen: Date.now(),
    context: null, tabs: new Map(), peers: new Set(), activeTabId: null
  };
  session.context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: false });
  session.context.setDefaultTimeout(15_000);
  // Re-check every navigated request, including redirects and subresources, to reduce SSRF exposure.
  await session.context.route('**/*', async route => {
    const requested = route.request().url();
    // Browser-generated resources such as data images and blob media are not network targets.
    if (/^(about:|data:|blob:)/i.test(requested)) { await route.continue(); return; }
    try { await validateUrl(requested); await route.continue(); }
    catch { await route.abort('blockedbyclient').catch(() => {}); }
  });
  if (typeof session.context.routeWebSocket === 'function') {
    await session.context.routeWebSocket('**/*', async route => {
      try {
        const checked = route.url().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
        await validateUrl(checked); await route.connect();
      } catch { route.close({ code: 1008, reason: 'Blocked by network policy' }); }
    });
  }
  const tab = await createTab(session);
  session.activeTabId = tab.id;
  sessions.set(session.id, session);
  return { session, token, tab };
}
async function closeSession(session, reason = 'Session closed') {
  sessions.delete(session.id);
  for (const peer of session.peers) if (peer.readyState === WebSocket.OPEN) peer.close(4408, reason);
  session.peers.clear();
  await session.context?.close().catch(() => {});
  session.tabs.clear();
}
async function handleHttp(req, res) {
  cors(req, res);
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return json(res, 403, { error: 'Origin not allowed.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://backend.local');
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!rateLimit(`http:${ip}`)) return json(res, 429, { error: 'Too many requests. Try again shortly.' });
  if (url.pathname === '/healthz' && req.method === 'GET') {
    return json(res, 200, { ok: true, runtime: 'playwright-chromium', activeSessions: sessions.size, maxSessions: MAX_SESSIONS });
  }
  try {
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      await readBody(req);
      const created = await createSession();
      log('session_created', { sessionId: created.session.id });
      return json(res, 201, { id: created.session.id, token: created.token, activeTabId: created.tab.id, tabs: [snapshot(created.tab)] });
    }
    const match = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json(res, 404, { error: 'Not found.' });
    const session = requireOwnedSession(req, match[1]);
    const action = match[2] || '';
    if (!action && req.method === 'DELETE') { await closeSession(session); return json(res, 200, { ok: true }); }
    if (action === 'tabs' && req.method === 'GET') return json(res, 200, { tabs: [...session.tabs.values()].map(snapshot), activeTabId: session.activeTabId });
    if (action === 'tabs' && req.method === 'POST') {
      await readBody(req);
      const tab = await createTab(session);
      await startStream(session, tab);
      return json(res, 201, { tab: snapshot(tab) });
    }
    const tabMatch = /^tabs\/([^/]+)(?:\/(navigate|back|forward|reload))?$/.exec(action);
    if (tabMatch) {
      const tab = session.tabs.get(decodeURIComponent(tabMatch[1]));
      if (!tab || tab.page.isClosed()) return json(res, 404, { error: 'That browser tab is no longer available.' });
      const operation = tabMatch[2] || '';
      if (!operation && req.method === 'DELETE') {
        await stopStream(tab);
        await tab.page.close().catch(() => {});
        session.tabs.delete(tab.id);
        if (!session.tabs.size) {
          const replacement = await createTab(session);
          await startStream(session, replacement);
        } else if (session.activeTabId === tab.id) {
          const next = session.tabs.values().next().value;
          await startStream(session, next);
        }
        return json(res, 200, { ok: true });
      }
      if (operation === 'navigate' && req.method === 'POST') {
        const body = await readBody(req);
        const destination = await validateUrl(body.url);
        const previousUrl = tab.page.url();
        tab.loading = true; emit(session, stateOf(tab));
        try {
          // Commit-based navigation avoids waiting for slow analytics, ads or trackers.
          await tab.page.goto(destination, { waitUntil: 'commit', timeout: 20_000 });
          tab.title = (await tab.page.title().catch(() => '')).slice(0, 300) || new URL(tab.page.url()).hostname;
          await updateTab(tab, false);
          await startStream(session, tab);
          return json(res, 200, { tab: snapshot(tab), navigationStarted: true });
        } catch (error) {
          // Recovery path: some sites keep loading trackers or long-lived requests after
          // the main document has already committed. Do not discard a usable page merely
          // because DOMContentLoaded was slow.
          const timedOut = /timeout/i.test(String(error?.message || error));
          const reachedDestination = tab.page.url() !== 'about:blank' && tab.page.url() !== previousUrl;
          if (timedOut && reachedDestination && !tab.page.isClosed()) {
            await tab.page.waitForLoadState('commit', { timeout: 2_000 }).catch(() => {});
            tab.title = (await tab.page.title().catch(() => '')).slice(0, 300) || new URL(tab.page.url()).hostname;
            await updateTab(tab, false).catch(() => {});
            await startStream(session, tab);
            log('navigation_recovered_after_timeout', { host: new URL(destination).hostname });
            return json(res, 200, { tab: snapshot(tab), recovered: true });
          }
          await updateTab(tab, false).catch(() => {});
          const message = timedOut ? 'The site took too long to finish loading. The browser tried a recovery path; retry or choose another address.' : 'The remote browser could not load this website. Check the URL or try another site.';
          emit(session, { type: 'error', tabId: tab.id, message });
          throw Object.assign(new Error(message), { statusCode: 422 });
        }
      }
      if (['back', 'forward', 'reload'].includes(operation) && req.method === 'POST') {
        await readBody(req);
        tab.loading = true; emit(session, stateOf(tab));
        try {
          if (operation === 'back') await tab.page.goBack({ waitUntil: 'commit', timeout: 15_000 });
          if (operation === 'forward') await tab.page.goForward({ waitUntil: 'commit', timeout: 15_000 });
          if (operation === 'reload') await tab.page.reload({ waitUntil: 'commit', timeout: 15_000 });
        } catch {}
        await updateTab(tab, false);
        await startStream(session, tab);
        return json(res, 200, { tab: snapshot(tab) });
      }
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) {
    const status = Number(error.statusCode) || 400;
    log('request_error', { method: req.method, path: url.pathname, status, error: String(error.message).slice(0, 180) });
    return json(res, status, { error: error.message || 'Request failed.' });
  }
}

const server = http.createServer((req, res) => handleHttp(req, res).catch(error => {
  log('unhandled_http_error', { error: String(error.message || error).slice(0, 200) });
  if (!res.headersSent) json(res, 500, { error: 'Unexpected backend error.' }); else res.end();
}));
const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://backend.local');
  if (!originAllowed(req.headers.origin) || url.pathname !== '/stream' || !rateLimit(`ws:${req.socket.remoteAddress}`, 20, 60_000)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://backend.local');
  const sessionId = url.searchParams.get('sessionId');
  const session = sessions.get(sessionId);
  if (!session) { ws.close(4401, 'Session not found'); return; }
  ws.authenticated = false;
  const timer = setTimeout(() => ws.close(4401, 'Authentication timeout'), 5000);
  ws.on('message', async raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (!ws.authenticated) {
        if (message.type !== 'auth' || !safeCompare(session.tokenHash, message.token)) { ws.close(4401, 'Invalid session token'); return; }
        clearTimeout(timer); ws.authenticated = true; ws.session = session; session.peers.add(ws); session.lastSeen = Date.now();
        ws.send(JSON.stringify({ type: 'ready', tabs: [...session.tabs.values()].map(snapshot), activeTabId: session.activeTabId }));
        const tab = session.tabs.get(session.activeTabId); if (tab) await startStream(session, tab);
        return;
      }
      session.lastSeen = Date.now();
      if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', at: Date.now() })); return; }
      const tab = session.tabs.get(message.tabId);
      if (message.type === 'activate' && tab) { await startStream(session, tab); return; }
      if (message.type === 'reorder') return; // The visual order is client-side; tab IDs remain stable.
      if (!tab || tab.page.isClosed()) return;
      if (message.type === 'resize') {
        const width = Math.max(320, Math.min(1920, Math.round(Number(message.width) || 1280)));
        const height = Math.max(240, Math.min(1200, Math.round(Number(message.height) || 800)));
        await tab.page.setViewportSize({ width, height }).catch(() => {}); return;
      }
      const cdp = tab.cdp;
      if (message.type === 'input') {
        const x = Math.max(0, Math.round(Number(message.x) || 0));
        const y = Math.max(0, Math.round(Number(message.y) || 0));
        const button = message.button === 2 ? 'right' : message.button === 1 ? 'middle' : 'left';
        if (cdp) {
          if (message.event === 'wheel') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(message.deltaX) || 0, deltaY: Number(message.deltaY) || 0 });
          else if (['mouseMoved', 'mousePressed', 'mouseReleased'].includes(message.event)) await cdp.send('Input.dispatchMouseEvent', { type: message.event, x, y, button, clickCount: 1 });
        } else {
          if (message.event === 'wheel') await tab.page.mouse.wheel(Number(message.deltaX) || 0, Number(message.deltaY) || 0);
          else if (message.event === 'mouseMoved') await tab.page.mouse.move(x, y);
          else if (message.event === 'mousePressed') await tab.page.mouse.down({ button });
          else if (message.event === 'mouseReleased') await tab.page.mouse.up({ button });
        }
      } else if (message.type === 'key') {
        const key = String(message.key || '').slice(0, 40), code = String(message.code || '').slice(0, 40);
        const modifiersData = message.modifiers || {};
        const modifiers = (modifiersData.alt ? 1 : 0) | (modifiersData.ctrl ? 2 : 0) | (modifiersData.meta ? 4 : 0) | (modifiersData.shift ? 8 : 0);
        if (cdp) {
          if (!modifiers && key.length === 1 && !['Enter', 'Tab'].includes(key)) await cdp.send('Input.insertText', { text: key });
          else {
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
          }
        } else {
          const modifierKeys = [];
          if (modifiersData.ctrl) modifierKeys.push('Control');
          if (modifiersData.alt) modifierKeys.push('Alt');
          if (modifiersData.shift) modifierKeys.push('Shift');
          if (modifiersData.meta) modifierKeys.push('Meta');
          if (!modifierKeys.length && key.length === 1 && !['Enter', 'Tab'].includes(key)) await tab.page.keyboard.insertText(key);
          else {
            for (const modifier of modifierKeys) await tab.page.keyboard.down(modifier);
            await tab.page.keyboard.press(key);
            for (const modifier of modifierKeys.reverse()) await tab.page.keyboard.up(modifier);
          }
        }
      } else if (message.type === 'type') {
        const text = String(message.text || '').slice(0, 1000);
        if (cdp) await cdp.send('Input.insertText', { text });
        else await tab.page.keyboard.insertText(text);
      }
    } catch (error) { log('ws_input_error', { error: String(error.message || error).slice(0, 160) }); }
  });
  ws.on('close', () => { clearTimeout(timer); session.peers.delete(ws); session.lastSeen = Date.now(); });
  ws.on('error', () => { clearTimeout(timer); session.peers.delete(ws); });
});

const sweep = setInterval(async () => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      log('session_expired', { sessionId: session.id });
      await closeSession(session, 'Session expired');
    }
  }
  for (const [key, bucket] of rateBuckets) if (bucket.until < now) rateBuckets.delete(key);
}, 15_000);
sweep.unref();
server.listen(PORT, '0.0.0.0', () => log('server_ready', { port: PORT, maxSessions: MAX_SESSIONS }));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  clearInterval(sweep);
  for (const session of [...sessions.values()]) await closeSession(session, 'Server shutting down');
  if (browserPromise) await browserPromise.then(b => b.close()).catch(() => {});
  server.close(() => process.exit(0));
});