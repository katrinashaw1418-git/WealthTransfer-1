#!/usr/bin/env bash
# =============================================================================
# scripts/db-backup-offsite.sh — ship pg_dump backups to an S3 bucket
# -----------------------------------------------------------------------------
# Task #170: the second half of the backup safety net. The daily in-process
# `database-backup` cron writes pg_dump output to $DB_BACKUP_DIR on the
# production host. That alone protects against an accidental DROP TABLE, but
# NOT against a host failure that takes the dump directory with it. This
# script is the offsite-shipping half: it `aws s3 sync`s every dump in
# $DB_BACKUP_DIR up to s3://$DB_BACKUP_OFFSITE_BUCKET/$DB_BACKUP_OFFSITE_PREFIX/
# so the dumps survive even if the production host is destroyed.
#
# Intended deployment:
#   * Cron entry on the production host (or any host that mounts the same
#     $DB_BACKUP_DIR), e.g.:
#         15 2 * * *  /opt/amax/scripts/db-backup-offsite.sh \
#                       >> /var/log/amax-db-backup-offsite.log 2>&1
#     scheduled ~30 minutes AFTER the in-process backup cron so the latest
#     dump has finished writing.
#   * Offsite retention is enforced on the bucket itself via an S3 lifecycle
#     policy (`docs/runbooks/rollback.md` documents the rule). This script
#     does NOT call `--delete`; deleting upstream dumps when they are pruned
#     locally would defeat the longer-retention point of offsite shipping.
#
# Required env:
#   DB_BACKUP_DIR              Local dump directory (same one the cron uses).
#   DB_BACKUP_OFFSITE_BUCKET   S3 bucket name (no scheme, no path).
# Optional env:
#   DB_BACKUP_OFFSITE_PREFIX   Path inside the bucket. Default 'dumps'.
#   DB_BACKUP_OFFSITE_REGION   Passed to aws as --region.
#   AWS_PROFILE                Passed to aws as --profile.
#   DB_BACKUP_OFFSITE_SSE      --sse value, e.g. AES256. Default unset.
#   DATABASE_URL               If set, the outcome (success or failure) is
#                              recorded into `background_job_runs` via
#                              `scripts/record-offsite-backup-run.ts` so the
#                              `database-backup-watchdog` (Task #260) can
#                              page when the offsite cron silently breaks.
#                              When unset, the script still runs and exits
#                              with the same code; the absence of recorded
#                              runs is itself what eventually trips the
#                              watchdog (offsite-never-run / offsite-stale).
#
# Exit codes:
#   0  success (bytes uploaded or already in sync)
#   1  configuration error (missing env / missing aws CLI / missing dir)
#   2  aws s3 sync exited non-zero
# =============================================================================

set -euo pipefail

log() {
  printf '[db-backup-offsite] %s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "FAIL: $*"
  exit "${2:-1}"
}

if [[ -z "${DB_BACKUP_DIR:-}" ]]; then
  fail "DB_BACKUP_DIR is not set. Set it to the same path the in-process backup cron writes to."
fi
if [[ ! -d "$DB_BACKUP_DIR" ]]; then
  fail "DB_BACKUP_DIR ($DB_BACKUP_DIR) does not exist or is not a directory."
fi
if [[ -z "${DB_BACKUP_OFFSITE_BUCKET:-}" ]]; then
  fail "DB_BACKUP_OFFSITE_BUCKET is not set. Set it to the S3 bucket name (no scheme, no path)."
fi
if ! command -v aws >/dev/null 2>&1; then
  fail "aws CLI not found on PATH. Install awscli v2 on this host."
fi

PREFIX="${DB_BACKUP_OFFSITE_PREFIX:-dumps}"
PREFIX="${PREFIX#/}"
PREFIX="${PREFIX%/}"
DEST="s3://${DB_BACKUP_OFFSITE_BUCKET}/${PREFIX}/"

aws_args=("--no-progress")
if [[ -n "${DB_BACKUP_OFFSITE_REGION:-}" ]]; then
  aws_args+=("--region" "$DB_BACKUP_OFFSITE_REGION")
fi
if [[ -n "${AWS_PROFILE:-}" ]]; then
  aws_args+=("--profile" "$AWS_PROFILE")
fi

sync_extra=()
if [[ -n "${DB_BACKUP_OFFSITE_SSE:-}" ]]; then
  sync_extra+=("--sse" "$DB_BACKUP_OFFSITE_SSE")
fi
# Only ship our own filename pattern. Anything else in the directory is
# someone else's problem and shouldn't be uploaded.
sync_extra+=("--exclude" "*" "--include" "amax-db-backup-*.dump")

log "starting sync src=$DB_BACKUP_DIR dst=$DEST"

# Capture timing on both sides of `aws s3 sync` so the recorded
# background_job_runs row carries an accurate duration. epoch-ms via `date
# +%s%3N` (GNU coreutils) — falls back to seconds×1000 on macOS / BusyBox.
now_ms() {
  local ms
  ms=$(date +%s%3N 2>/dev/null || true)
  if [[ -z "$ms" || "$ms" == *N ]]; then
    ms=$(( $(date +%s) * 1000 ))
  fi
  printf '%s' "$ms"
}

started_at_ms=$(now_ms)

set +e
aws "${aws_args[@]}" s3 sync "$DB_BACKUP_DIR" "$DEST" "${sync_extra[@]}"
sync_status=$?
set -e

finished_at_ms=$(now_ms)

# Best-effort: record the outcome into background_job_runs so the
# database-backup-watchdog (Task #260) can page when the offsite cron
# silently breaks. The recorder needs DATABASE_URL; if it isn't set we
# skip with a warning rather than failing the cron — the absence of rows
# will itself trip the watchdog after the freshness window.
record_run() {
  local status="$1"
  local detail="$2"
  if [[ -z "${DATABASE_URL:-}" ]]; then
    log "WARN: DATABASE_URL not set; skipping background_job_runs record (watchdog will eventually page)."
    return 0
  fi
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local recorder="$script_dir/record-offsite-backup-run.ts"
  if [[ ! -f "$recorder" ]]; then
    log "WARN: $recorder not found; skipping background_job_runs record."
    return 0
  fi
  local args=(
    "--status=$status"
    "--started-at-ms=$started_at_ms"
    "--finished-at-ms=$finished_at_ms"
  )
  if [[ "$status" == "success" ]]; then
    args+=("--summary=$detail")
  else
    args+=("--message=$detail")
  fi
  set +e
  npx --no-install tsx "$recorder" "${args[@]}"
  local rec_status=$?
  set -e
  if [[ $rec_status -ne 0 ]]; then
    log "WARN: recorder exited $rec_status; watchdog row not written."
  fi
}

if [[ $sync_status -ne 0 ]]; then
  record_run "error" "aws s3 sync exited $sync_status (dst=$DEST)"
  fail "aws s3 sync exited $sync_status" 2
fi

duration_ms=$(( finished_at_ms - started_at_ms ))
record_run "success" "src=$DB_BACKUP_DIR dst=$DEST duration_ms=$duration_ms"

log "OK sync complete dst=$DEST"
exit 0
