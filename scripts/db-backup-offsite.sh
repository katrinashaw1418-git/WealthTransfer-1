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

set +e
aws "${aws_args[@]}" s3 sync "$DB_BACKUP_DIR" "$DEST" "${sync_extra[@]}"
sync_status=$?
set -e

if [[ $sync_status -ne 0 ]]; then
  fail "aws s3 sync exited $sync_status" 2
fi

log "OK sync complete dst=$DEST"
exit 0
