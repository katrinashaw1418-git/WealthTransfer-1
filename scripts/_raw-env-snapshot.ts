// Snapshot of process.env captured BEFORE any other module mutates it.
//
// Why this exists: scripts/_bootstrap-test-env.ts intentionally backfills
// `JWT_SECRET` / `NODE_ENV` with safe local defaults so dev-side
// verification scripts can boot. That mutation is correct for a developer
// running tests, but it is dangerous for the launch gate
// (scripts/go-no-go.ts) — a missing real production secret would be
// silently masked by the default and produce a false GO verdict.
//
// To validate raw env presence, the launch gate snapshots the env in
// THIS file and imports it BEFORE the bootstrap. ESM evaluates modules
// in dependency order, so a file that imports `_raw-env-snapshot` first
// and `_bootstrap-test-env` second is guaranteed to capture the
// untouched env values.
//
// Add a key here when the launch gate needs to assert it was set
// explicitly by the deploy environment, not by a dev-time fallback.

export const RAW_ENV_SNAPSHOT: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    NODE_ENV: process.env.NODE_ENV,
    LOG_DIR: process.env.LOG_DIR,
    OPERATOR_ALERT_WEBHOOK_URL: process.env.OPERATOR_ALERT_WEBHOOK_URL,
    DB_BACKUP_DIR: process.env.DB_BACKUP_DIR,
  });
