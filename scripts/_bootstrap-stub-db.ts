// Side-effect bootstrap for tests that import the go-no-go module chain
// (which depth-pulls server/db.ts) but never run a real DB query because
// they stub the dispatcher.
//
// Imported as the FIRST line of any test that does NOT need a real DB
// connection but WOULD otherwise crash at module init because
// `server/db.ts` throws when DATABASE_URL is unset. Pairs with
// `_bootstrap-test-env.ts` which sets NODE_ENV / JWT_SECRET.
//
// The placeholder URL is syntactically valid for `new Pool()` but no
// connection is opened until a query runs. Tests that only stub
// `notifyOperator()` (e.g. `scripts/test-deploy-gate-rollup.ts`) never
// reach that point.
import "./_bootstrap-test-env";

process.env.DATABASE_URL ||=
  "postgres://stub:stub@127.0.0.1:5432/stub?sslmode=disable";

export {};
