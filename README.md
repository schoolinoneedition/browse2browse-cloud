# Browse2Browse Cloud

Browse2Browse Cloud is a separate remote Chromium browser project. The static site is served by GitHub Pages and the browser engine is a Docker/Playwright service in `backend/`. It does not use the old Cloudflare Browser Run worker, so the old per-network daily browser cap is not used.

## Repository and site

- Source: https://github.com/schoolinoneedition/browse2browse-cloud
- Frontend URL after Pages deployment: https://schoolinoneedition.github.io/browse2browse-cloud/
- Backend deployment blueprint: `render.yaml`, expected Render service name `browse2browse-cloud-backend`

GitHub Pages cannot run Chromium. In Render, choose **New → Blueprint**, connect this repository, and deploy the service described by `render.yaml`. Confirm the backend's actual URL matches `apiBase` in `config.js`. Verify `https://YOUR-BACKEND/healthz` returns JSON containing `ok: true`, then test a public HTTPS website from the Pages site, including typing, clicking, scrolling, navigation and multiple tabs. A healthy endpoint alone does not prove destination websites load. Render Free sleeps when idle and has limited memory, so heavy websites may need a larger plan.

## XBT Supabase integration — separated by table name

The app connects to the existing XBT Supabase project only for these newly created tables:

- `public.browser2browse_preferences`
- `public.browser2browse_bookmarks`
- `public.browser2browse_history`

Their SQL is in `supabase/migrations/20261023000000_browser2browse_tables.sql`. The migration has already been applied and verified. All three tables have row-level security enabled and four owner-only policies. Browse2Browse does not read or alter the XBT app's existing tables such as `enquiries`, `staff_roles` or `radar_leads`.

The project URL and publishable key in `config.js` are public browser-client values. Never put a Supabase service-role or secret key in the frontend. In Supabase Auth settings, allow `https://schoolinoneedition.github.io/browse2browse-cloud/` as a redirect URL and enable email-link sign-in. If needed, expose only the three new prefixed tables through the Data API while keeping their RLS policies enabled.

Only preferences, bookmarks and a limited recent URL list are synced. Temporary browser-session tokens, site cookies and page contents are not stored in Supabase.

## Local backend development

Requires Node.js 22+ and a Docker/Playwright-compatible Chromium runtime.

```sh
cd backend
npm install
npx playwright install --with-deps chromium
ALLOWED_ORIGINS=http://localhost:5173 PORT=10000 npm start
```

Serve the root frontend from `http://localhost:5173` and set `apiBase` in `config.js` to `http://localhost:10000`.

## Security and limits

- Only public HTTP/HTTPS destinations are accepted; private, loopback, link-local, local and metadata addresses are blocked using URL and DNS checks. Host-level network egress controls are still recommended.
- Browser contexts are isolated and expire; cookies and site storage are temporary.
- Some pop-ups, downloads, DRM, extension, media and permission flows may not work.
- Respect website terms and administrator access policies. This is not designed to bypass access restrictions.
