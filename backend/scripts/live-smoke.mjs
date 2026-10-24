import WebSocket from 'ws';
import { chromium } from 'playwright';

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
  // The free production service allows one browser session. A previous smoke run
  // can leave a session alive until its idle TTL expires, and a real visitor may
  // also be using it. Wait for genuine free capacity rather than opening a second
  // session or reporting a misleading browser failure.
  const end = Date.now() + 9 * 60_000;
  let last = {};
  let servicesReady = false;

  while (Date.now() < end) {
    try {
      if (!servicesReady) {
        const [home, fixture, health] = await Promise.all([
          get(frontend + '/', 8_000),
          get(frontend + '/smoke-fixture.html', 8_000),
          get(api + '/health', 8_000)
        ]);
        const homeText = home.ok ? await home.text() : '';
        const fixtureText = fixture.ok ? await fixture.text() : '';
        last = {
          frontend: home.status,
          fixture: fixture.status,
          backendHealth: health.status
        };
        servicesReady = home.ok && homeText.includes('Browse2Browse Cloud') && homeText.includes('app.js?v=14')
          && fixture.ok && fixtureText.includes('Remote Browser Test') && health.ok;
        if (!servicesReady) {
          await sleep(10_000);
          continue;
        }
      }

      const liveness = await get(api + '/healthz', 8_000);
      const livenessData = liveness.ok ? await liveness.json().catch(() => null) : null;
      const activeSessions = Number(livenessData?.activeSessions);
      const maxSessions = Number(livenessData?.maxSessions);
      last = {
        frontend: 'ready',
        fixture: 'ready',
        backendLiveness: liveness.status,
        activeSessions: Number.isFinite(activeSessions) ? activeSessions : 'unknown',
        maxSessions: Number.isFinite(maxSessions) ? maxSessions : 'unknown'
      };
      if (liveness.ok && Number.isFinite(activeSessions) && Number.isFinite(maxSessions)
        && activeSessions < maxSessions) return;
    } catch (error) {
      last = { error: String(error?.message || error) };
      servicesReady = false;
    }
    await sleep(10_000);
  }
  throw new Error(`Public Render services did not provide a free browser session within nine minutes: ${JSON.stringify(last)}`);
}
async function waitSessionUrl(id, token, suffix, timeout=timeoutMs) {
  const end = Date.now() + timeout;
  let last = null;
  let lastError = null;
  while (Date.now() < end) {
    const state = await apiRequest(`/api/session/${id}`, { token, timeout: 8_000 });
    if (state.response.ok) {
      last = state.data;
      lastError = null;
      const tab = (last.tabs || []).find(item => item.id === last.activeTabId);
      if (tab?.url?.includes(suffix)) return { state: last, tab };
    } else {
      lastError = `HTTP ${state.response.status} ${state.raw.slice(0,180)}`;
    }
    // Keep polling below the backend's per-IP rate limit, even across many checks.
    await sleep(750);
  }
  throw new Error(`Session did not reach ${suffix}; last state: ${JSON.stringify(last)}; latest status error: ${lastError || 'none'}`);
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
  const expected = new URL(url).href;
  const retryDelays = [800, 1800, 3500];
  let result = null;
  let lastFailure = '';

  // Render's free web service can briefly return its own 502 while waking or
  // restarting. Retry only transient gateway/server failures, with a strict
  // bound; bad URLs, ownership failures and other 4xx responses still fail.
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      result = await apiRequest(`/api/session/${id}/navigate`, { method: 'POST', token, body: { url } });
      if (result.response.ok) break;
      lastFailure = `HTTP ${result.response.status} ${result.raw.slice(0, 240)}`;
      if (![502, 503, 504].includes(result.response.status) || attempt === retryDelays.length) {
        throw new Error(`Navigation failed for ${url}: ${lastFailure}`);
      }
    } catch (error) {
      if (result?.response && ![502, 503, 504].includes(result.response.status)) throw error;
      lastFailure = String(error?.message || error).slice(0, 320);
      if (attempt === retryDelays.length) {
        throw new Error(`Navigation failed for ${url} after ${attempt + 1} attempts: ${lastFailure}`);
      }
    }

    const delay = retryDelays[attempt];
    console.warn(`RETRY transient remote navigation failure for ${new URL(url).hostname} in ${delay}ms (attempt ${attempt + 2}/${retryDelays.length + 1}): ${lastFailure}`);
    await sleep(delay);
    // A readiness probe confirms whether the API is back; failures are allowed
    // here because the next bounded navigation attempt is the actual test.
    await get(api + '/health', 8_000).catch(() => null);
    result = null;
  }

  assert(result?.response.ok, `Navigation failed for ${url}: ${lastFailure || 'no successful response'}`);
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

  const stopped = await apiRequest(`/api/sessions/${id}/tabs/${activeTabId}/stop`, { method:'POST', token, body:{} });
  assert(stopped.response.ok && stopped.data.status === 'ready', `Stop control failed: HTTP ${stopped.response.status} ${stopped.raw}`);
  console.log('PASS Stop control reaches the live browser');

  const newTabResponse = await apiRequest(`/api/sessions/${id}/tabs`, { method:'POST', token, body:{} });
  assert(newTabResponse.response.status === 201 && newTabResponse.data.tab?.id, `New tab failed: HTTP ${newTabResponse.response.status} ${newTabResponse.raw}`);
  const secondTabId = newTabResponse.data.tab.id;
  ws.send(JSON.stringify({ type:'activate', tabId:secondTabId }));
  await navigate(id, token, secondTabId, 'https://example.com/');
  console.log('PASS new tab opened and rendered its own real browser page');

  const closeTabResponse = await apiRequest(`/api/sessions/${id}/tabs/${secondTabId}`, { method:'DELETE', token });
  assert(closeTabResponse.response.ok, `Close tab failed: HTTP ${closeTabResponse.response.status} ${closeTabResponse.raw}`);
  const afterClose = await waitSessionUrl(id, token, 'smoke-fixture.html');
  assert(afterClose.state.activeTabId === activeTabId, 'Closing the second tab did not restore the previous tab.');
  console.log('PASS close tab restores the previous live tab');

  const sessionStatus = await apiRequest(`/api/session/${id}`, { token });
  assert(sessionStatus.response.ok && ['ready','disconnected'].includes(sessionStatus.data.status), `Session status endpoint failed: HTTP ${sessionStatus.response.status} ${sessionStatus.raw}`);
  console.log('PASS session status endpoint reports current state');

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

  // Exercise the deployed web UI in a real local test browser, including its own
  // WebSocket connection. This catches frontend wiring errors that API-only tests miss.
  let uiBrowser;
  let uiPage;
  let uiSession = null;
  const pageErrors = [];
  const consoleErrors = [];
  const uiApiFailures = [];
  const uiRequestFailures = [];
  const uiSocketEvents = [];
  let uiPrimaryError = null;
  try {
    uiBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    // Chromebook-like viewport: the app must use the whole browser tab, not a card.
    uiPage = await uiBrowser.newPage({ viewport: { width: 1366, height: 768 } });
    uiPage.setDefaultTimeout(20_000);
    uiPage.on('pageerror', error => pageErrors.push(String(error?.message || error)));
    uiPage.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    uiPage.on('requestfailed', request => {
      const u = new URL(request.url());
      if (u.pathname.startsWith('/api/') || u.pathname === '/stream') {
        uiRequestFailures.push({ path: u.pathname, error: request.failure()?.errorText || 'request failed' });
      }
    });
    uiPage.on('websocket', socket => {
      const path = new URL(socket.url()).pathname;
      uiSocketEvents.push({ event: 'created', path });
      socket.on('close', () => uiSocketEvents.push({ event: 'closed', path }));
      socket.on('socketerror', error => uiSocketEvents.push({ event: 'error', path, error: String(error).slice(0, 140) }));
    });
    uiPage.on('response', async response => {
      try {
        const u = new URL(response.url());
        if (u.pathname.startsWith('/api/') && response.status() >= 400) {
          uiApiFailures.push({ path: u.pathname, status: response.status() });
        }
        if (u.pathname === '/api/sessions' && response.request().method() === 'POST' && response.ok()) {
          uiSession = await response.json();
        }
      } catch {}
    });

    const homepage = await uiPage.goto(frontend + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assert(homepage?.status() === 200, `Frontend homepage did not return HTTP 200: ${homepage?.status()}`);
    assert((await uiPage.title()).includes('Browse2Browse'), 'Frontend title was not rendered.');
    const viewportLayout = await uiPage.evaluate(() => {
      const rect = document.querySelector('#browser')?.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        browserWidth: rect?.width || 0,
        browserHeight: rect?.height || 0,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      };
    });
    assert(Math.abs(viewportLayout.browserWidth - viewportLayout.viewportWidth) <= 1
      && Math.abs(viewportLayout.browserHeight - viewportLayout.viewportHeight) <= 1,
      `Browser UI did not fill the whole tab: ${JSON.stringify(viewportLayout)}`);
    assert(viewportLayout.bodyScrollWidth <= viewportLayout.viewportWidth + 1
      && viewportLayout.bodyScrollHeight <= viewportLayout.viewportHeight + 1,
      `Unexpected page overflow on Chromebook-sized viewport: ${JSON.stringify(viewportLayout)}`);
    console.log('PASS full-tab layout fits a Chromebook-like 1366×768 viewport');

    await uiPage.setViewportSize({ width: 1920, height: 1080 });
    const wideLayout = await uiPage.evaluate(() => {
      const rect = document.querySelector('#browser')?.getBoundingClientRect();
      return { viewportWidth:window.innerWidth,viewportHeight:window.innerHeight,
        browserWidth:rect?.width||0,browserHeight:rect?.height||0,
        bodyScrollWidth:document.body.scrollWidth,bodyScrollHeight:document.body.scrollHeight };
    });
    assert(Math.abs(wideLayout.browserWidth-wideLayout.viewportWidth)<=1
      && Math.abs(wideLayout.browserHeight-wideLayout.viewportHeight)<=1
      && wideLayout.bodyScrollWidth<=wideLayout.viewportWidth+1
      && wideLayout.bodyScrollHeight<=wideLayout.viewportHeight+1,
      `The UI did not resize cleanly to a Windows-sized viewport: ${JSON.stringify(wideLayout)}`);
    await uiPage.setViewportSize({ width:1366,height:768 });
    console.log('PASS responsive layout at a 1920×1080 Windows-sized viewport');
    try {
      await uiPage.waitForFunction(() => document.querySelector('#statusText')?.textContent.includes('Connected'), null, { timeout: 60_000 });
    } catch (error) {
      const diagnostics = await uiPage.evaluate(() => ({
        status: document.querySelector('#statusText')?.textContent || '',
        connection: document.querySelector('#connectionText')?.textContent || '',
        api: window.B2B_CONFIG?.apiBase || '',
        appScript: [...document.scripts].map(script => script.src).find(src => src.includes('app.js')) || '',
        viewerVisible: !document.querySelector('#remoteView')?.hidden
      })).catch(() => ({}));
      throw new Error(`Frontend auto-connect timed out: ${JSON.stringify(diagnostics)}; sessionResponseSeen=${!!uiSession?.id}; API failures=${JSON.stringify(uiApiFailures)}; request failures=${JSON.stringify(uiRequestFailures)}; WebSocket events=${JSON.stringify(uiSocketEvents)}; page errors=${JSON.stringify(pageErrors)}; console errors=${JSON.stringify(consoleErrors)}; original=${String(error?.message || error)}`);
    }
    const uiSessionDeadline = Date.now() + 5_000;
    while ((!uiSession?.id || !uiSession?.token) && Date.now() <= uiSessionDeadline) await sleep(50);
    assert(uiSession?.id && uiSession?.token, 'Frontend did not create an authenticated remote browser session.');
    console.log('PASS real frontend JavaScript and auto-connect');

    const waitAddress = async fragment => uiPage.waitForFunction(
      expected => document.querySelector('#address')?.value.includes(expected),
      fragment,
      { timeout: 30_000 }
    );
    const waitViewerFrame = async () => uiPage.waitForFunction(() => {
      const view = document.querySelector('#remoteView');
      return view && !view.hidden && view.src.startsWith('data:image/jpeg;base64,') && view.naturalWidth > 0;
    }, null, { timeout: 25_000 });
    const waitUiSessionUrl = async (suffix, timeout=30_000) => {
      const end = Date.now() + timeout;
      let last = null, lastError = null;
      while (Date.now() < end) {
        const current = uiSession;
        if (current?.id && current?.token) {
          const state = await apiRequest(`/api/session/${current.id}`, { token:current.token, timeout:8_000 });
          if (state.response.ok) {
            last = state.data;
            lastError = null;
            const tab = (last.tabs || []).find(item => item.id === last.activeTabId);
            if (tab?.url?.includes(suffix)) return { state:last, tab };
          } else lastError = `HTTP ${state.response.status} ${state.raw.slice(0,180)}`;
        }
        await sleep(750);
      }
      throw new Error(`Frontend session did not reach ${suffix}; last state: ${JSON.stringify(last)}; latest status error: ${lastError || 'none'}`);
    };
    const navigateFromUI = async url => {
      const navigationResponse = uiPage.waitForResponse(response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/navigate'),
        { timeout:25_000 }
      );
      await uiPage.locator('#address').fill(url);
      await uiPage.locator('#addressForm').press('Enter');
      const response = await navigationResponse;
      const apiStatus = response.status();
      const responseBody = await response.text().catch(() => '');
      if (apiStatus >= 400 && apiStatus < 500 && apiStatus !== 401) {
        throw new Error(`Address bar navigation was rejected: HTTP ${apiStatus} ${responseBody.slice(0,400)}`);
      }
      if (apiStatus === 503 && /capacity/i.test(responseBody)) {
        throw new Error(`Address bar navigation blocked by browser capacity: ${responseBody.slice(0,400)}`);
      }
      const parsed = new URL(url);
      const suffix = parsed.pathname.split('/').pop() || parsed.hostname;
      try {
        await waitUiSessionUrl(suffix, apiStatus >= 500 || apiStatus === 401 ? 60_000 : 30_000);
      } catch (error) {
        const uiState = await uiPage.evaluate(() => ({
          status:document.querySelector('#statusText')?.textContent || '',
          address:document.querySelector('#address')?.value || '',
          error:document.querySelector('#message')?.innerText || '',
          tabs:document.querySelectorAll('#tabStrip .tab').length
        })).catch(() => ({}));
        throw new Error(`Address bar navigation failed for ${url}: API HTTP ${apiStatus} ${responseBody.slice(0,400)}; UI=${JSON.stringify(uiState)}; ${String(error?.message || error)}`);
      }
      await waitViewerFrame();
    };
    const clickRemoteAt = async (remoteX, remoteY) => {
      const metrics = await uiPage.locator('#remoteView').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const viewport = document.querySelector('#viewport').getBoundingClientRect();
        return { x:rect.x,y:rect.y,width:rect.width,height:rect.height,
          viewportWidth:viewport.width,viewportHeight:viewport.height,
          naturalWidth:element.naturalWidth,naturalHeight:element.naturalHeight };
      });
      assert(metrics.width > 0 && metrics.height > 0 && metrics.naturalWidth > 0 && metrics.naturalHeight > 0,
        'The live remote browser image has no usable dimensions.');
      // Click page CSS coordinates. The encoded frame may be downscaled, so its
      // natural pixel dimensions must not be used as the input coordinate system.
      await uiPage.mouse.click(
        metrics.x + remoteX / metrics.viewportWidth * metrics.width,
        metrics.y + remoteY / metrics.viewportHeight * metrics.height
      );
    };

    // Exercise a wide Windows viewport while the remote stream is downscaled/
    // re-encoded, then prove the remote image and input coordinates still align.
    await uiPage.setViewportSize({ width: 1920, height: 1080 });
    await sleep(500);
    await navigateFromUI(frontend + '/smoke-fixture.html');
    await uiPage.waitForFunction(() => {
      const view = document.querySelector('#remoteView');
      return view && view.naturalWidth >= 1800 && view.naturalHeight > 0;
    }, null, { timeout: 20_000 });
    console.log('PASS remote stream remains full-width at a 1920px viewport');
    console.log('PASS address bar navigated through the actual frontend');

    await clickRemoteAt(90, 38);
    await sleep(250);
    await uiPage.keyboard.type('b2b-ui-smoke');
    await sleep(250);
    await clickRemoteAt(90, 88);
    await waitSessionUrl(uiSession.id, uiSession.token, '#interaction-b2b-ui-smoke');
    console.log('PASS frontend mouse and keyboard events control the remote page');

    const remoteCssWidth = await uiPage.locator('#viewport').evaluate(element => element.getBoundingClientRect().width);
    await clickRemoteAt(remoteCssWidth - 140, 38);
    await sleep(250);
    await uiPage.keyboard.type('b2b-edge');
    await sleep(250);
    await clickRemoteAt(remoteCssWidth - 90, 88);
    await waitSessionUrl(uiSession.id, uiSession.token, '#edge-interaction-b2b-edge');
    console.log('PASS right-edge mouse and keyboard mapping on a 1920px viewer');

    await clickRemoteAt(850, 500);
    await uiPage.mouse.wheel(0, 1000);
    await waitSessionUrl(uiSession.id, uiSession.token, '#scrolled-');
    console.log('PASS frontend scrolling changes the remote page');

    await uiPage.setViewportSize({ width:1366,height:768 });
    await sleep(350);
    await navigateFromUI('https://example.com/');
    await uiPage.locator('#back').click();
    await waitSessionUrl(uiSession.id, uiSession.token, '#scrolled-');
    const forwardRequest = uiPage.waitForRequest(request => new URL(request.url()).pathname.endsWith('/forward') && request.method() === 'POST');
    await uiPage.locator('#forward').click();
    await forwardRequest;
    await waitSessionUrl(uiSession.id, uiSession.token, 'example.com');
    const reloadRequest = uiPage.waitForRequest(request => new URL(request.url()).pathname.endsWith('/reload') && request.method() === 'POST');
    await uiPage.locator('#reload').click();
    await reloadRequest;
    await waitSessionUrl(uiSession.id, uiSession.token, 'example.com');
    await waitViewerFrame();
    console.log('PASS frontend back, forward and reload controls');

    // Reopen the fixture directly before testing tab lifecycle. Back/Forward are
    // already tested above; this avoids coupling the new-tab check to website history.
    await navigateFromUI(frontend + '/smoke-fixture.html');
    const priorTabs = await uiPage.locator('#tabStrip .tab').count();
    await uiPage.locator('#newTab').click();
    await uiPage.waitForFunction(count => document.querySelectorAll('#tabStrip .tab').length === count + 1, priorTabs);
    await uiPage.locator('#address').fill('https://example.com/');
    await uiPage.locator('#addressForm').press('Enter');
    await waitSessionUrl(uiSession.id, uiSession.token, 'example.com');
    await uiPage.locator('#tabStrip .tab.active .tab-close').click();
    await uiPage.waitForFunction(count => document.querySelectorAll('#tabStrip .tab').length === count, priorTabs);
    await waitSessionUrl(uiSession.id, uiSession.token, 'smoke-fixture.html');
    console.log('PASS frontend new-tab and close-tab controls');

    assert(pageErrors.length === 0, `Frontend JavaScript exceptions: ${pageErrors.join(' | ')}`);
    assert(consoleErrors.length === 0, `Frontend console errors: ${consoleErrors.join(' | ')}`);
    console.log('PASS frontend reports no JavaScript or console errors');
  } catch (error) {
    uiPrimaryError = error;
    throw error;
  } finally {
    await uiBrowser?.close().catch(() => {});
    if (uiSession?.id && uiSession?.token) {
      try {
        const uiClosed = await apiRequest(`/api/session/${uiSession.id}`, { method:'DELETE', token:uiSession.token, timeout:15_000 });
        if (!uiClosed.response.ok || uiClosed.data.status !== 'closed') {
          const detail = `Frontend-created session cleanup failed: HTTP ${uiClosed.response.status} ${uiClosed.raw}`;
          if (uiPrimaryError) console.error('SECONDARY CLEANUP FAILURE: ' + detail);
          else throw new Error(detail);
        } else console.log('PASS frontend-created browser session cleaned up');
      } catch (cleanupError) {
        if (uiPrimaryError) console.error('SECONDARY CLEANUP FAILURE: ' + String(cleanupError?.message || cleanupError));
        else throw cleanupError;
      }
    }
  }

  console.log('LIVE RENDER RESULT: PASS');
} catch (error) {
  console.error('LIVE RENDER RESULT: FAIL');
  console.error(String(error?.stack || error));
  process.exitCode = 1;
} finally {
  await cleanup();
}
