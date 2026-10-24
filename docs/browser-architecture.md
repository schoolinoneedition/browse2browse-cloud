# Browser architecture and implementation decision

Last reviewed: 2026-10-24

## Chosen runtime

Browse2Browse uses a real Playwright-managed Chromium process inside the Render Docker web service. Each user session receives a separate Playwright BrowserContext, unique opaque session ID, random owner token, its own tabs and an idle timeout. The owner token is hashed server-side; requests must present it as a Bearer token and the requested session ID must match the authenticated session.

The viewer is not an iframe and not a website-content proxy. The backend starts the Chrome DevTools Protocol Page.startScreencast stream and forwards native JPEG screencast frames to an authenticated WebSocket. Pointer, wheel and keyboard events are sent to the real page through CDP/Playwright. On stream startup or reconnection, a single current compositor keyframe initializes a static page; the native CDP screencast remains required for continued interaction and updates. The server fails the viewer session if native streaming cannot start instead of switching to screenshot-only browsing.

The API provides:
- GET /healthz: inexpensive process liveness for Render.
- GET /health: verifies the browser runtime is connected and can create a context/page.
- GET /health/browser: creates a temporary context and verifies a real navigation to https://example.com/.
- POST /api/session (also /api/sessions): creates a session and returns its ID, owner token and active tab.
- GET /api/session/:id: returns state only when the caller owns the session.
- POST /api/session/:id/navigate: navigates the active tab, with per-tab back/forward/reload/stop routes.
- DELETE /api/session/:id: closes the browser context and its viewer sockets.

The backend rejects non-HTTP(S) URLs, local/private/link-local/metadata destinations, checks DNS answers and re-checks resources to reduce SSRF exposure. Session count and tab count are bounded. Host-level egress restrictions remain recommended.

## Alternative infrastructure examined

### Steel Browser

Repository: https://github.com/steel-dev/steel-browser

Steel is Apache-2.0 licensed, actively maintained, has a Docker/Render configuration, a session API, Playwright/CDP access and a native live debug streamer. It is a credible alternative for programmatic browsing. Its session-service implementation currently centres on a single active session and its debug-stream routes omit normal request hooks, so adopting it as an internet-facing multi-user viewer would require a carefully designed owner-token gateway, stream authentication and lifecycle changes. It is not a drop-in replacement that can safely be swapped into this frontend without that integration work.

### BrowserBox

Repository: https://github.com/BrowserBox/BrowserBox

The current repository licence requires a valid paid licence key and says an unlicensed instance terminates after a short period. It is therefore not an appropriate assumed-free dependency for this project.

### Auto Browser

Repository: https://github.com/LvcidPsyche/auto-browser

Auto Browser is MIT licensed and documents a real Playwright browser node with Xvfb/VNC/noVNC takeover, plus a separate controller and configurable per-session isolation. Its recommended deployment is a multi-container stack on a private host behind an access gateway. It is a credible path if Browse2Browse moves to an always-on host that can run that stack, but it is not a minimal single-service Render replacement.

### noVNC directly

noVNC is a mature VNC client, not a browser engine. Using it alone would still require a separate desktop, real browser, VNC server and WebSocket gateway. That would be a larger runtime change than needed while the current CDP viewer can be tested end-to-end.

## Decision

Keep the current engine for this recovery pass and fix its concrete failure modes instead of switching to a different engine merely by name. The public smoke tests have created remote sessions, loaded public websites, received live CDP frames and exercised page input/navigation. The remaining completion gate is a passing live reconnect test against the latest deployed commit; local syntax tests or a green homepage are not sufficient.

## Deployment reality

The Render Blueprint uses the supported static-site shape (type: web, runtime: static) for the frontend and a Docker web service for the backend. The backend currently uses Render's free plan and permits one concurrent browser session. That is suitable for a limited prototype, not a promise of high concurrency or an always-on service; cold starts, CPU and memory limits can still affect heavier pages.

## Test commands

From the repository root:

    npm install --prefix backend
    npm test --prefix backend
    npm run test:e2e --prefix backend
    node backend/scripts/live-smoke.mjs

The local E2E command starts a real backend and Chromium, navigates public websites, verifies actual JPEG frames and exercises browser controls. The live smoke script exercises the configured public Render frontend and backend, including typing, clicks, scrolling, navigation, reconnect and cleanup. It requires the public deployment to be reachable and the frontend to publish smoke-fixture.html.
