# Deploy on Railway

## 1. Overview

This application is a **Node.js + Express** monolith: the server bundles the API and serves the built client assets in production. Deploy it on Railway as a **long-lived web service** (a persistent Node process). It is **not** suitable as a serverless function — background crons, DB pooling, and in-process schedulers expect a continuously running process.

## 2. Required environment variables

Set these in Railway **Variables** (or linked secret store) for production:

| Variable | Notes |
|----------|--------|
| `DATABASE_URL` | PostgreSQL connection string (Neon-compatible). Must allow TLS (see Database). |
| `JWT_SECRET` | Strong secret for signing JWTs. The server **refuses to boot** in production-like environments if this is missing. |
| `NODE_ENV` | Set to **`production`**. |
| `LOG_DIR` | Writable path for rotating logs (e.g. persistent volume mount). Required for full **go-no-go** / deploy hygiene per internal runbooks. |
| `OPERATOR_ALERT_WEBHOOK_URL` | Webhook URL for operator alerts. Required for launch readiness checks that expect alerting to be configured. |
| `DB_BACKUP_DIR` | Directory for DB backup artefacts when the backup pipeline is enabled; required where the **go-no-go** infrastructure gate expects backups. |
| `PLATFORM_USER_ID` | Numeric `users.id` of the platform ledger identity used for fee / ledger credit legs. Must match the row created in your database. |

See also the repo root **`.env.example`** for the same names and placeholders.

## 3. Optional environment variables

| Variable | Notes |
|----------|--------|
| `METRICS_TOKEN` | Bearer token for locking down `/metrics`. |
| `METRICS_ALLOW_FROM` | CIDR / shortcut allow-list for `/metrics` scrapers. |
| `SUMSUB_APP_TOKEN` | Sumsub KYC — required when Sumsub is live. |
| `SUMSUB_SECRET_KEY` | Sumsub KYC — required when Sumsub is live. |
| `SUMSUB_BASE_URL` | Sumsub API base URL. |
| `SUMSUB_LEVEL_NAME` | Sumsub verification level name. |
| `SUMSUB_TOKEN_TTL_SECS` | Optional TTL for Sumsub tokens. |
| `GMAIL_USER` | Outbound email (if using Gmail transport). |
| `GMAIL_APP_PASSWORD` | Gmail app password (if using Gmail transport). |
| `APP_BASE_URL` | Public site base URL for links in emails (no trailing slash). |

Additional toggles and tuning keys exist; see `.env.example` and `docs/DEPLOYMENT_RUNBOOK.md`.

## 4. Database

- The app targets **PostgreSQL** (e.g. **Neon** via `@neondatabase/serverless`).
- **`DATABASE_URL`** must point at your Postgres instance with **SSL/TLS** enabled (Neon URLs typically include `sslmode=require` or equivalent).
- **Before the first deploy** (or after schema changes), apply the schema to the target database, for example:

  ```bash
  npm run db:push
  ```

  Run this with `DATABASE_URL` set to the **same** database Railway will use at runtime (often from a local shell or a one-off Railway shell).

- If the app starts but queries fail with **`relation ... does not exist`**, migrations / `db:push` were not applied against that database.

## 5. Build and start

From `package.json`:

| Phase | Command | Purpose |
|-------|---------|---------|
| Install | `npm install` | Install dependencies. |
| Build | `npm run build` | Produces `dist/` (Vite client + bundled `dist/index.js` server). **Required before `start`.** |
| Start | `npm run start` | Runs `NODE_ENV=production node dist/index.js`. |

**Railway:** set the **build** step to install **and** compile, e.g.:

```bash
npm install && npm run build
```

Set the **start** command to:

```bash
npm run start
```

If you only run `npm install` and then `npm run start` without `npm run build`, the service will fail because `dist/index.js` will be missing.

## 6. Port configuration

- The server reads **`PORT`** from the environment (default **5000** if unset).
- **Railway injects `PORT` automatically**; the process must listen on `process.env.PORT`.
- Do not hardcode a public URL to port 5000 in production — use Railway’s assigned host and port, or a custom domain in front of the service.

## 7. Domain

- Railway’s **default `*.up.railway.app` (or current equivalent)** hostname works for smoke tests.
- **Custom domain** is optional: attach it in the Railway service settings and ensure TLS termination there matches your `APP_BASE_URL` / reverse proxy expectations.

## 8. Pre-launch checklist

After the service is configured and the database schema is applied:

1. From a shell with the **same** env as production (or against the production DB with care), run the focused readiness script:

   ```bash
   npx tsx scripts/go-no-go-check.ts
   ```

2. The script must report **`Result: GO`** (all gates pass). A **NO-GO** exit must be resolved before treating the deployment as launch-ready.

For the full automated gate used in other deploy pipelines, see `docs/runbooks/go-no-go.md` and `scripts/go-no-go.ts`.

## 9. Common issues

| Symptom | Likely cause | What to check |
|---------|----------------|----------------|
| `relation "..." does not exist` | Schema not applied to this database | Run `npm run db:push` (or equivalent) against the Railway `DATABASE_URL` database. |
| **502** / connection refused from Railway | Process not listening on **`PORT`**, or crash on boot | Logs: confirm `PORT` is set; confirm `npm run build` ran; confirm `JWT_SECRET` / `DATABASE_URL` present. |
| Auth errors / invalid tokens | **`JWT_SECRET`** missing, rotated without redeploy, or mismatch across replicas | Set a stable `JWT_SECRET` in Railway variables; redeploy all instances. |
| DB connection errors | **`DATABASE_URL`** missing, wrong host, or SSL not accepted | Verify variable; Neon requires TLS; no accidental spaces or quotes stripping. |
| Metrics exposed publicly | **`METRICS_TOKEN`** / **`METRICS_ALLOW_FROM`** unset | Set at least one lock per `server/metrics.ts` behaviour. |

---

*This document describes Railway-specific wiring only. For Replit-centric steps and historical deploy wiring, see `docs/DEPLOYMENT_RUNBOOK.md`.*
