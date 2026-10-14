// Usage: APP_DATA_CLASS=SYNTHETIC pnpm demo:reset --confirm [--site <uuid>]
// Truncates the demo/ops data and reloads the §18.1 standard scenario. Destructive, so --confirm is
// required and the data class must be SYNTHETIC (ADR-015). Reads DATABASE_URL_UNPOOLED (or
// DATABASE_URL); never prints the URL or any secret. Operator shells only: it refuses outright if
// VERCEL_ENV is set to anything, so it can never run from a build, function or deploy hook
// (demoResetCliGate; DECISION-LEDGER #43 — one shared DB).
import pg from "pg";
import { runAfterCommit, type Db } from "../src/db/exec";
import { demoResetCliGate } from "../src/modules/demo/reset";
import { seedStandardScenario } from "../src/modules/demo/seed";

/** One dedicated connection, so the seed's single transaction is a real transaction. */
async function withClientDb<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await c.connect();
  const query = async (sql: string, params: unknown[]) => ({ rows: (await c.query(sql, params)).rows });
  const db: Db = {
    query,
    async tx(body) {
      const hooks: (() => Promise<void>)[] = [];
      await c.query("BEGIN");
      try {
        const r = await body({ query }, (h) => hooks.push(h));
        await c.query("COMMIT");
        await runAfterCommit(hooks);
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    },
  };
  try { return await fn(db); } finally { await c.end(); }
}

async function main() {
  const argv = process.argv.slice(2);
  const gate = demoResetCliGate(process.env, argv);
  if (!gate.allowed) throw new Error(gate.reason);
  const siteArg = argv.indexOf("--site");
  const siteId = siteArg >= 0 ? argv[siteArg + 1] : undefined;
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set");
  const r = await withClientDb(url, (db) => seedStandardScenario(db, { now: new Date(), siteId }));
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e: Error) => {
  console.error(`demo reset refused: ${e.message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]")}`);
  process.exit(1);
});
