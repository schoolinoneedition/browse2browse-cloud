# Deployment status

- [x] Separate GitHub repository created: https://github.com/schoolinoneedition/browse2browse-cloud
- [x] Browser frontend, Playwright backend, Dockerfile, Render blueprint and Pages workflow included in this repository.
- [x] XBT Supabase project has the `browser2browse_preferences`, `browser2browse_bookmarks`, and `browser2browse_history` tables, each with RLS and owner-only policies.
- [x] Local JavaScript syntax and JSON configuration checks passed before upload.
- [ ] GitHub Pages workflow must finish; expected site URL: https://schoolinoneedition.github.io/browse2browse-cloud/
- [ ] The Render backend must be deployed from `render.yaml`. Expected service URL is configured in `config.js`, but must be verified in the Render dashboard.
- [ ] Verify `/healthz`, open a public HTTPS website, test real clicks/typing/scrolling, and confirm multi-tab navigation on the deployed backend.

Do not treat a successful static-site build or `/healthz` alone as proof that Chromium can load and interact with destination websites.