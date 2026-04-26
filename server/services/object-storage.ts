// =============================================================================
// TASK #99 — OBJECT STORAGE BACKEND FOR CLIENT DOCUMENTS
// -----------------------------------------------------------------------------
// A small, dependency-free filesystem-backed object store used by the client-
// document upload + download flow. The storageKey strings written into
// `clientDocuments.storageKey` are computed HERE — never trusted from caller
// input — so a hostile adviser cannot point a row at an arbitrary path on
// disk.
//
// Layout on disk:
//   <ROOT>/<safePrefix>/<random32hex><.ext>
//
// where <ROOT> defaults to .local/object-storage and can be overridden by the
// OBJECT_STORAGE_ROOT env var (e.g. when wired to a mounted volume in
// production). All file paths are resolved through resolveSafe() which
// rejects "..", absolute paths, and any segment that would escape ROOT.
//
// The interface mirrors the small subset of S3 / Replit Object Storage we
// actually use (put / get-stream / head / delete) so swapping backends later
// is a single-file edit.
// =============================================================================

import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Readable } from "node:stream";

const DEFAULT_ROOT = path.resolve(process.cwd(), ".local/object-storage");

function rootDir(): string {
  const fromEnv = process.env.OBJECT_STORAGE_ROOT;
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_ROOT;
}

export interface PutObjectInput {
  // A logical namespace for the key, e.g. "client-documents/<userId>".
  // Sanitised below — anything outside [A-Za-z0-9_/-] is replaced with "_".
  prefix: string;
  // Original filename — used ONLY to derive a sanitised extension on the
  // storage key. The full filename is NOT preserved on disk (the row in
  // clientDocuments holds the human-readable name).
  fileName: string;
  bytes: Buffer;
}

export interface PutObjectResult {
  storageKey: string;
  sizeBytes: number;
}

export async function putObject(input: PutObjectInput): Promise<PutObjectResult> {
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
    throw Object.assign(new Error("Empty upload"), { status: 400 });
  }
  const safePrefix = input.prefix
    .split("/")
    .map((seg) => seg.replace(/[^A-Za-z0-9_-]/g, "_"))
    .filter((seg) => seg.length > 0)
    .join("/");
  if (safePrefix.length === 0) {
    throw Object.assign(new Error("Invalid storage prefix"), { status: 400 });
  }
  const random = crypto.randomBytes(16).toString("hex");
  const rawExt = path.extname(input.fileName).slice(0, 16);
  const safeExt = rawExt.replace(/[^.A-Za-z0-9]/g, "");
  const storageKey = `${safePrefix}/${random}${safeExt}`;
  const fullPath = path.join(rootDir(), storageKey);
  // Defence-in-depth: confirm the resolved path is still inside ROOT.
  if (!fullPath.startsWith(rootDir() + path.sep)) {
    throw Object.assign(new Error("Refusing to write outside object store root"), {
      status: 500,
    });
  }
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, input.bytes);
  return { storageKey, sizeBytes: input.bytes.length };
}

export async function getObjectBytes(storageKey: string): Promise<Buffer> {
  return fs.readFile(resolveSafe(storageKey));
}

export function getObjectStream(storageKey: string): Readable {
  return createReadStream(resolveSafe(storageKey));
}

export async function statObject(
  storageKey: string,
): Promise<{ sizeBytes: number } | null> {
  try {
    const s = await fs.stat(resolveSafe(storageKey));
    return { sizeBytes: s.size };
  } catch {
    return null;
  }
}

export async function deleteObject(storageKey: string): Promise<void> {
  try {
    await fs.unlink(resolveSafe(storageKey));
  } catch {
    // already absent — treat as success (delete is idempotent)
  }
}

// Translate a stored storageKey back into an absolute on-disk path with
// strict path-traversal guards. Throws 400 on anything suspicious so a
// corrupted DB row can never coerce a read outside ROOT.
function resolveSafe(storageKey: string): string {
  if (typeof storageKey !== "string" || storageKey.length === 0) {
    throw Object.assign(new Error("Invalid storage key"), { status: 400 });
  }
  // Normalise using POSIX rules (storage keys are always /-separated even on
  // Windows-style hosts) and reject anything that would escape ROOT.
  const normalized = path.posix.normalize(storageKey);
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("..") ||
    normalized.split("/").some((seg) => seg === "..")
  ) {
    throw Object.assign(new Error("Invalid storage key"), { status: 400 });
  }
  const fullPath = path.join(rootDir(), normalized);
  if (!fullPath.startsWith(rootDir() + path.sep)) {
    throw Object.assign(new Error("Invalid storage key"), { status: 400 });
  }
  return fullPath;
}
