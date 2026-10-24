# Deployment status

Last verified: 2026-10-24

- [x] Source repository and separate frontend/backend structure: https://github.com/schoolinoneedition/browse2browse-cloud
- [x] Live public frontend: https://browse2browse-cloud.onrender.com/
- [x] Live remote-browser API: https://browse2browse-cloud-backend.onrender.com/
- [x] Render Blueprint validated with a supported static frontend service and a Docker backend service.
- [x] Playwright/Chromium backend creates a separate browser context for each owned session.
- [x] Browser URL policy regression tests pass in GitHub Actions.
- [x] Local CI browser integration test creates a real browser, opens websites, validates CDP JPEG frames, exercises navigation and deletes its session.
- [x] Production Render smoke passed against the public URLs: browser health, session creation, authenticated viewer WebSocket, example.com, a JavaScript-heavy website, back/forward/reload, live frame delivery, mouse click, keyboard typing, scrolling, unsafe URL rejection, viewer reconnect and session cleanup.
- [x] Render site serves the versioned frontend bundle and public test fixture required by the live smoke workflow.
- [x] Supabase integration remains optional for core browsing; only the dedicated browser2browse preferences/bookmarks/history tables are used for user sync.
- [x] Prior production reconnect failure was reproduced, fixed with stream restart + current keyframe, and re-tested successfully.

## Verification links

- Production end-to-end smoke, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40090082849
- Additional production end-to-end smoke, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40090015357
- Local real-browser integration CI, PASS: https://github.com/schoolinoneedition/browse2browse-cloud/actions/runs/40089432283
- URL-policy test coverage and CI configuration: https://github.com/schoolinoneedition/browse2browse-cloud/actions

## Remaining constraints

- Render's current free backend is configured for one concurrent browser session. Cold starts, memory limits and CPU limits can affect heavy websites; this is a small prototype setup, not production-scale capacity.
- This container could not resolve public internet hosts for a direct local curl test, so the production check was run from GitHub Actions runners with public network access.
- Some sites may disallow automation or may not work because of DRM, downloads, extensions, browser permissions or site-specific requirements.
- Respect site terms and administrator access rules. Browse2Browse is not designed to bypass access restrictions.

A passing homepage or lightweight /healthz endpoint alone is not considered proof of browser functionality; the linked production smoke test exercises the real browser and viewer.
