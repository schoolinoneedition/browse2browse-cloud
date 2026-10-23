# Browse2Browse Cloud

A separate cloud browser project. The UI is published as a Render static site and the remote browser engine runs in a Docker/Playwright service in `backend/`. It does not use the old Cloudflare Browser Run service that hit its daily network quota.

## Project links

- Source repository: https://github.com/schoolinoneedition/browse2browse-cloud
- Expected frontend URL after Render Blueprint deployment: https://browse2browse-cloud.onrender.com
- Expected browser API: https://browse2browse-cloud-backend.onrender.com
- Blueprint: `render.yaml`

## Deploy the app

The repo now defines both the static website and the browser backend in one Render Blueprint. Open Render, select **New → Blueprint**, connect `schoolinoneedition/browse2browse-cloud`, and deploy. Render will create both resources from `render.yaml`. Confirm the final URLs in Render match `apiBase` in `config.js` and the backend's `ALLOWED_ORIGINS`. If Render assigns a different available subdomain, update those two settings in a follow-up commit.

Then open the backend's `/healthz` endpoint; it should return JSON with `ok: true`. Finally, test loading a public HTTPS site from the frontend, including typing, clicks, scrolling, back/forward and multiple tabs. A successful build or a healthy `/healthz` alone does not prove remote websites load correctly. Render's free backend can sleep when idle and has limited memory; heavier pages may require a larger plan.

GitHub Actions validates JavaScript and configuration files. GitHub Pages publishing is intentionally not enabled by this workflow because this project's GitHub connection cannot enable Pages; Render Blueprint is the deployment path for both services.

## XBT Supabase integration — separate tables only

The existing XBT Supabase project is used for three new, isolated tables:

- `public.browser2browse_preferences`
- `public.browser2browse_bookmarks`
- `public.browser2browse_history`

The migration is `supabase/migrations/20261023000000_browser2browse_tables.sql`. It has already been applied and verified: all three tables have row-level security enabled and four owner-only policies each. Browse2Browse does not read or alter the existing XBT tables such as `enquiries`, `staff_roles` or `radar_leads`.

The project URL and publishable key in `config.js` are browser-safe values. Never place a Supabase service-role or secret key in frontend files. In Supabase Auth URL settings, allow `https://browse2browse-cloud.onrender.com/` as a redirect URL and enable email-link sign-in. If the tables are not exposed through the Data API, expose only the three new prefixed tables while keeping their RLS policies enabled.

Only preferences, bookmarks and a limited recent URL list are synced. Temporary Chromium session tokens, site cookies and page contents are not stored in Supabase.

## Local development

Requires Node.js 22+ and a Docker/Playwright-compatible Chromium runtime.

```sh
cd backend
npm install
npx playwright install --with-deps chromium
ALLOWED_ORIGINS=http://localhost:5173 PORT=10000 npm start
```

Serve the root frontend from `http://localhost:5173` and set `apiBase` in `config.js` to `http://localhost:10000`.

## Security and limits

- The backend accepts public HTTP/HTTPS destinations only and blocks private, loopback, link-local, local and metadata destinations with URL and DNS checks. Host-level network egress controls are still recommended.
- Browser contexts are isolated and temporary; cookies and site storage are cleared when a session expires.
- Some pop-ups, downloads, DRM, extensions, media and permission flows may not work.
- Respect site terms and administrator access rules. This is not designed to bypass access restrictions.
