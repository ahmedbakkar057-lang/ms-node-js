# Vercel deployment

This project is Vercel-compatible as a web control panel and API. Vercel detects `server.js` as an Express Function, and the browser pages are included under `public/`.

## Deploy

1. Import this project into Vercel.
2. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `PUBLIC_REGISTRATION` in Project Settings → Environment Variables.
3. Deploy with the default Node.js settings.

## Important limitation

Vercel Functions are request-based, use a read-only filesystem except for temporary `/tmp` storage, and do not provide an always-on process manager. Therefore this deployment runs the panel/API, but it intentionally does not start permanent user bots. For actual Node.js bot hosting, run the same project on a persistent Node host such as a VPS, Render, Railway, or similar.

File uploads on Vercel are limited by the platform request-size limit and are temporary unless an external object store/database is added.
