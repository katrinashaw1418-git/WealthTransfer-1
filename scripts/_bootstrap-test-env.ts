// Task #92 spec step 1 (lines 38-51 of .local/tasks/task-92.md):
// JWT_SECRET / env bootstrap that MUST execute before any module reads
// `process.env.JWT_SECRET` at import time. The spec specifies the exact
// shape of this block as the "first lines" of the test script — but
// ES modules hoist all static `import` statements above any executable
// code in the same file, so the only way to honor the spec's intent
// (env set before any other module loads) is to put it in this isolated
// bootstrap module that sibling test scripts import as their FIRST line,
// before any other import.
import "dotenv/config";

process.env.NODE_ENV ||= "test";
process.env.JWT_SECRET ||= "test-jwt-secret";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET not loaded");
}

export {};
