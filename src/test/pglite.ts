import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAfterCommit, type Db } from "@/db/exec";

export const SITE = "00000000-0000-7000-8000-000000000001";
export const ORG = "00000000-0000-7000-8000-000000000002";

/** Fresh in-memory DB with all drizzle/ migrations applied, plus one SYN org + site. Test-only. */
export async function freshDb(): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite();
  const dir = join(__dirname, "..", "..", "drizzle");
  const j = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const e of j.entries) for (const s of readFileSync(join(dir, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (s.trim()) await pg.exec(s);
  await pg.exec(`INSERT INTO ops.org (id,name,created_by,updated_by) VALUES ('${ORG}','SYN Org','test','test');
    INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by) VALUES ('${SITE}','${ORG}','SYN Site',26.645352,-80.145541,'test','test');`);
  const db: Db = {
    query: async (sql, params) => ({ rows: (await pg.query(sql, params)).rows as never[] }),
    async tx(fn) {
      const hooks: (() => Promise<void>)[] = [];
      const r = await pg.transaction(async (t) =>
        fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params)).rows as never[] }) }, (h) => hooks.push(h)));
      await runAfterCommit(hooks);
      return r;
    },
  };
  return { pg, db };
}
