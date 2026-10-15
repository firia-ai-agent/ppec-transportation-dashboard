import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transition, StaleOrConflict, IllegalTransition } from "@/domain/transition";
import { TASK } from "@/domain/machines";

// Applies drizzle/ migrations in journal order to an in-memory PGlite (no Neon yet; U8 still open for real Neon).
const dir = join(__dirname, "..", "..", "drizzle");
const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
let db: PGlite;
const SITE = "00000000-0000-7000-8000-000000000001";
const ORG = "00000000-0000-7000-8000-000000000002";
const aud = `'test','test'`;

const applyMigration = async (tag: string) => {
  const sql = readFileSync(join(dir, `${tag}.sql`), "utf8");
  for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await db.exec(stmt);
};

beforeAll(async () => {
  db = new PGlite();
  for (const e of journal.entries) await applyMigration(e.tag);
  await db.exec(`INSERT INTO ops.org (id,name,created_by,updated_by) VALUES ('${ORG}','SYN Org',${aud});
    INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by) VALUES ('${SITE}','${ORG}','SYN Site',26.645352,-80.145541,${aud});`);
}, 60_000);

describe("migrations 0000 + 0001 on PGlite", () => {
  it("migrator owns every ops/identity table and both schemas", async () => {
    const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('ops','identity') AND tableowner <> 'migrator'`);
    expect(r.rows[0].n).toBe(0);
    const sc = await db.query<{ o: string }>(`SELECT pg_get_userbyid(nspowner) o FROM pg_namespace WHERE nspname IN ('ops','identity')`);
    expect(sc.rows.map((x) => x.o)).toEqual(["migrator", "migrator"]);
  });
  it("default privileges: a table migrator creates later gets app_rw/readonly grants", async () => {
    await db.exec(`SET ROLE migrator; CREATE TABLE ops.zz_probe (id int); RESET ROLE;`);
    const r = await db.query<{ a: boolean; b: boolean }>(`SELECT has_table_privilege('app_rw','ops.zz_probe','INSERT') a, has_table_privilege('readonly','ops.zz_probe','SELECT') b`);
    expect(r.rows[0]).toEqual({ a: true, b: true });
    await db.exec(`DROP TABLE ops.zz_probe`);
  });
  it("identity tables reference ops.site; guardian_contact references family_group; scenario_clock references site", async () => {
    const r = await db.query<{ t: string; c: string }>(`SELECT tc.table_schema||'.'||tc.table_name t, kcu.column_name c FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema) WHERE tc.constraint_type='FOREIGN KEY'
      AND (tc.table_schema='identity' OR tc.table_name='scenario_clock') ORDER BY 1,2`);
    expect(r.rows).toEqual([
      { t: "identity.child_identity", c: "site_id" }, { t: "identity.external_person_identity", c: "site_id" },
      { t: "identity.guardian_contact", c: "family_group_id" }, { t: "identity.guardian_contact", c: "site_id" },
      { t: "ops.scenario_clock", c: "site_id" },
    ]);
  });
  it("creates ops and identity schemas with job.claimed_until", async () => {
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='ops' AND table_name='job'`);
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toEqual(expect.arrayContaining(["claimed_at", "claimed_by", "claimed_until", "due_at", "state"]));
  });
  it("has foreign keys (ON DELETE RESTRICT) and none from ops into identity", async () => {
    const r = await db.query<{ n: number }>(`SELECT count(*)::int n FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='ops'`);
    expect(r.rows[0].n).toBe(90);
    const x = await db.query<{ n: number }>(`SELECT count(*)::int n FROM information_schema.constraint_column_usage u
      JOIN information_schema.table_constraints c USING (constraint_name) WHERE c.table_schema='ops' AND u.table_schema='identity'`);
    expect(x.rows[0].n).toBe(0);
    const d = await db.query<{ n: number }>(`SELECT count(*)::int n FROM information_schema.referential_constraints WHERE delete_rule <> 'RESTRICT' AND constraint_schema='ops'`);
    expect(d.rows[0].n).toBe(0);
  });
  it("rejects a row pointing at a missing site", async () => {
    await expect(db.exec(`INSERT INTO ops.family_group (id,site_id,display_label,created_by,updated_by)
      VALUES ('00000000-0000-7000-8000-0000000000ff','00000000-0000-7000-8000-00000000dead','F9 (Demo)',${aud})`)).rejects.toThrow();
  });
  it("task CLOSED_VERIFIED requires completion_evidence (AGT-04)", async () => {
    await expect(db.exec(`INSERT INTO ops.task (id,site_id,category,severity,state,summary,completion_predicate,created_by,updated_by)
      VALUES ('00000000-0000-7000-8000-0000000000a1','${SITE}','x','RED','CLOSED_VERIFIED','s','p',${aud})`)).rejects.toThrow();
  });
  it("guarded transition: legal edge bumps version; stale version conflicts; illegal edge never hits the DB", async () => {
    const id = "00000000-0000-7000-8000-0000000000a2";
    await db.exec(`INSERT INTO ops.task (id,site_id,category,severity,summary,completion_predicate,created_by,updated_by)
      VALUES ('${id}','${SITE}','x','AMBER','s','p',${aud})`);
    const r = await transition(db, TASK, "ops.task", { id, version: 1, from: "OPEN", to: "IN_PROGRESS", actor: "S", by: "staff:test" });
    expect(r.version).toBe(2);
    await expect(transition(db, TASK, "ops.task", { id, version: 1, from: "OPEN", to: "IN_PROGRESS", actor: "S", by: "staff:test" }))
      .rejects.toBeInstanceOf(StaleOrConflict);
    await expect(transition(db, TASK, "ops.task", { id, version: 2, from: "IN_PROGRESS", to: "CLOSED_VERIFIED", actor: "S", by: "staff:test" }))
      .rejects.toBeInstanceOf(IllegalTransition);
  });
  it("ADR-001 claim: second claim returns 0 rows; expired lease is reclaimable", async () => {
    const id = "00000000-0000-7000-8000-0000000000b1";
    await db.exec(`INSERT INTO ops.job (id,site_id,key,kind,payload,due_at,created_by,updated_by)
      VALUES ('${id}','${SITE}','k1','TEST','{}',now(),${aud})`);
    const claim = `UPDATE ops.job SET state='CLAIMED', claimed_at=now(), claimed_by='d1', claimed_until=now()+interval '60 seconds'
      WHERE id=$1 AND state='SCHEDULED' AND due_at<=now()+interval '1 second' RETURNING id`;
    expect((await db.query(claim, [id])).rows.length).toBe(1);
    expect((await db.query(claim, [id])).rows.length).toBe(0);
    const reclaim = `UPDATE ops.job SET state='SCHEDULED', attempts=attempts+1, claimed_until=NULL
      WHERE state='CLAIMED' AND claimed_until < now() RETURNING id`;
    expect((await db.query(reclaim, [])).rows.length).toBe(0);
    await db.exec(`UPDATE ops.job SET claimed_until = now() - interval '1 second' WHERE id='${id}'`);
    expect((await db.query(reclaim, [])).rows.length).toBe(1);
  });
  it("live job key is unique while SCHEDULED/CLAIMED", async () => {
    await db.exec(`INSERT INTO ops.job (id,site_id,key,kind,payload,due_at,created_by,updated_by)
      VALUES ('00000000-0000-7000-8000-0000000000b2','${SITE}','k2','TEST','{}',now(),${aud})`);
    await expect(db.exec(`INSERT INTO ops.job (id,site_id,key,kind,payload,due_at,created_by,updated_by)
      VALUES ('00000000-0000-7000-8000-0000000000b3','${SITE}','k2','TEST','{}',now(),${aud})`)).rejects.toThrow();
  });
  it("roles: app_rw cannot read identity or update append-only logs", async () => {
    const g = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('app_rw','identity.child_identity','SELECT') ok`);
    expect(g.rows[0].ok).toBe(false);
    const u = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('app_rw','ops.audit_event','UPDATE') ok`);
    expect(u.rows[0].ok).toBe(false);
    const w = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('app_rw','ops.task','UPDATE') ok`);
    expect(w.rows[0].ok).toBe(true);
    const ig = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('identity_gateway','identity.consent_event','UPDATE') ok`);
    expect(ig.rows[0].ok).toBe(false);
    const del = await db.query<{ a: boolean; b: boolean }>(`SELECT has_table_privilege('app_rw','ops.outbound_message','DELETE') a, has_table_privilege('app_rw','ops.message','DELETE') b`);
    expect(del.rows[0]).toEqual({ a: false, b: false });
    const ro = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('readonly','ops.task','INSERT') ok`);
    expect(ro.rows[0].ok).toBe(false);
  });
});

// 0006 uses CREATE UNIQUE INDEX IF NOT EXISTS so a retried deploy step (or a hand re-applied migration)
// is a no-op rather than a duplicate-object error. beforeAll already applied it once in journal order, so
// re-applying the same file here is the second run.
describe("0006 thread_counterparty_live_uq re-applies cleanly", () => {
  const liveUq = () => db.query<{ def: string }>(`SELECT indexdef def FROM pg_indexes
    WHERE schemaname='ops' AND tablename='conversation_thread' AND indexname='thread_counterparty_live_uq'`);
  it("runs twice without error and leaves exactly one unchanged index", async () => {
    const before = await liveUq();
    expect(before.rows.length).toBe(1);
    await expect(applyMigration("0006_thread_counterparty_live_uq")).resolves.toBeUndefined();
    const after = await liveUq();
    expect(after.rows.map((x) => x.def)).toEqual([before.rows[0].def]);
    expect(before.rows[0].def).toContain("CREATE UNIQUE INDEX");
    expect(before.rows[0].def).toMatch(/\(site_id, counterparty_token, channel\)/);
    expect(before.rows[0].def).toMatch(/WHERE \(state <> 'CLOSED'/);
  });
});

/**
 * 0007 (B-08 slice 2): what the run loop needs from `ops.agent_tool_call` and could not express
 * before — the persist-before-execute status, and one effect key per call. Written with the same
 * IF NOT EXISTS / EXCEPTION-swallowing shape as 0006, so re-applying it is a no-op.
 */
describe("0007 agent run loop columns (PRD §11.1)", () => {
  const RUN = "00000000-0000-7000-8000-0000000000d1";
  const CALL = "00000000-0000-7000-8000-0000000000d2";

  it("agent_tool_call has status (default PENDING) and idempotency_key", async () => {
    const cols = await db.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
       WHERE table_schema='ops' AND table_name='agent_tool_call' AND column_name IN ('status','idempotency_key')
       ORDER BY column_name`);
    expect(cols.rows).toEqual([
      { column_name: "idempotency_key", column_default: null, is_nullable: "NO" },
      { column_name: "status", column_default: "'PENDING'::agent_tool_call_status", is_nullable: "NO" },
    ]);
    const labels = await db.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname='agent_tool_call_status' ORDER BY e.enumsortorder`);
    expect(labels.rows.map((r) => r.enumlabel)).toEqual(["PENDING", "EXECUTED", "BLOCKED", "PROPOSED", "FAILED"]);
  });

  it("one run per (trigger_type, trigger_id); one row per (run, seq); one effect key per call", async () => {
    await db.exec(`INSERT INTO ops.agent_run (id,site_id,trigger_type,trigger_id,created_by,updated_by)
      VALUES ('${RUN}','${SITE}','msg.inbound','MSG-D1',${aud})`);
    // §11.1 idempotency: a redelivered trigger cannot make a second run.
    await expect(db.exec(`INSERT INTO ops.agent_run (id,site_id,trigger_type,trigger_id,created_by,updated_by)
      VALUES ('00000000-0000-7000-8000-0000000000d3','${SITE}','msg.inbound','MSG-D1',${aud})`)).rejects.toThrow();

    const call = (id: string, seq: number, key: string) =>
      db.exec(`INSERT INTO ops.agent_tool_call (id,site_id,run_id,seq,tool,args_hash,args,policy_decision,idempotency_key,created_by,updated_by)
        VALUES ('${id}','${SITE}','${RUN}',${seq},'get_leg_state','h','{}','ALLOW:read','${key}',${aud})`);
    await call(CALL, 0, `agent:${RUN}:0`);
    const row = await db.query<{ status: string; committed_at: Date | null }>(
      `SELECT status, committed_at FROM ops.agent_tool_call WHERE id='${CALL}'`);
    expect(row.rows[0]).toEqual({ status: "PENDING", committed_at: null });

    await expect(call("00000000-0000-7000-8000-0000000000d4", 0, `agent:${RUN}:9`)).rejects.toThrow();
    await expect(call("00000000-0000-7000-8000-0000000000d5", 1, `agent:${RUN}:0`)).rejects.toThrow();
    // A distinct seq with a distinct key is the ordinary next step, and is accepted.
    await expect(call("00000000-0000-7000-8000-0000000000d6", 1, `agent:${RUN}:1`)).resolves.toBeDefined();
  });

  it("the resume sweep has its index, and the file re-applies cleanly", async () => {
    const idx = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='ops' AND indexname='agent_run_resume_idx'`);
    expect(idx.rows[0].indexdef).toMatch(/\(site_id, state\)/);
    await expect(applyMigration("0007_agent_tool_call_status")).resolves.toBeUndefined();
    const again = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_indexes WHERE schemaname='ops'
       AND indexname IN ('agent_run_resume_idx','agent_tool_call_idem_uq')`);
    expect(again.rows[0].n).toBe(2);
  });
});
