# Deployment status

Last verified: 2026-10-24

- [x] Source repository and separate frontend/backend structure: https://github.com/schoolinoneedition/browse2browse-cloud
- [x] Live public frontend: https://browse2browse-cloud.onrender.com/
- [x] Live remote-browser API: https://browse2browse-cloud-backend.onrender.com/
- [x] Render Blueprint uses the supported static frontend service shape and Docker backend service. Render's readiness check is now the browser-aware /health endpoint.
- [x] Playwright/Chromium backend creates an isolated BrowserContext for each owned session.
- [x] URL-policy regression tests pass in GitHub Actions.
- [x] Local CI browser integration test creates a real browser, opens websites, validates native CDP JPEG frames, exercises browser input/navigation and deletes its session.
- [x] Production Render smoke passed against the public URLs: browser health, session creation, authenticated viewer WebSocket, example.com, a JavaScript-heavy website, back/forward/reload, live frame delivery, mouse click, keyboard typing, scrolling, unsafe URL rejection, viewer reconnect and session cleanup.
- [x] Expanded production smoke passed: session capacity limit, Stop control, new tab, close tab, return to previous tab, session-status API and final cleanup.
- [x] Render serves the current frontend bundle and the public test fixture used to prove real mouse/keyboard/scroll interaction.
- [x] Supabase remains optional for core browsing; only the dedicated browser2browse preferences/bookmarks/history tables are used for user sync.
- [x] A prior production reconnect failure was reproduced, fixed with stream restart/current keyframes, and re-tested successfully.

## Verification links

- Expanded public Render end-to-end smoke, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40090429557
- Browser-aware Render health-check CI, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40090379818
- Earlier full public smoke, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40090082849
- Local real-browser integration CI, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40089432283
- All workflow runs: https://github.com/schoolinoneedition/browse2browse-cloud/actions

## Remaining constraints

- Render's current free backend is configured for one concurrent browser session. Cold starts, memory limits and CPU limits can affect heavier websites; this is a prototype setup, not production-scale capacity.
- This execution container could not resolve public internet hosts for a direct local curl test, so production verification was performed from GitHub Actions runners that have public network access.
- Some sites may disallow automation or may not work because of DRM, downloads, extensions, browser permissions or site-specific requirements.
- Respect site terms and administrator access rules. Browse2Browse is not designed to bypass access restrictions.

A passing homepage or lightweight process liveness endpoint alone is not considered proof of browser functionality. The linked production smoke tests create a real session and exercise the actual browser stream and controls.
