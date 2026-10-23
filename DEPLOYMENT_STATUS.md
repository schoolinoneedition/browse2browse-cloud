# Deployment status

- [x] Separate source repository created and populated: https://github.com/schoolinoneedition/browse2browse-cloud
- [x] Playwright/Chromium backend, Dockerfile, and Render Blueprint.
- [x] Render Blueprint defines both static frontend and browser backend services.
- [x] XBT Supabase isolated `browser2browse_*` tables created.
- [x] Verified each table has RLS enabled and four owner-only policies.
- [x] Frontend code uses only the three new prefixed Supabase tables.
- [x] Local application syntax and configuration checks passed in GitHub Actions.
- [ ] Deploy the Blueprint from Render to create the actual public website and backend.
- [ ] Confirm actual Render subdomains match `config.js` and backend CORS configuration.
- [ ] Test real website loading, mouse/keyboard input, navigation and multiple tabs against the deployed backend.

A successful JavaScript/configuration check or `/healthz` endpoint is not proof that remote websites load and interact correctly.
