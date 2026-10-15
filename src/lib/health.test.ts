import { beforeEach, expect, it, vi } from "vitest";
import { DB_ROLE_SQL, healthPayload, readDbRole, roleNameOf } from "./health";

/**
 * The probe's one database read (`dbRole`) goes through the shared autocommit path, so the pool is
 * stubbed here: what matters is the statement it sends, the one field it adds, and that nothing it
 * gets back can turn into a failed probe or into a connection string on the wire.
 */
const query = vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock("@/db/exec", () => ({ getNeonDb: () => ({ query, tx: vi.fn() }) }));

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [{ role: "ppec_preview" }] });
});

it("reports commit and data class, no secrets", () => {
  const p = healthPayload({ VERCEL_GIT_COMMIT_SHA: "abc123", APP_DATA_CLASS: "SYNTHETIC", AUTH_SECRET: "x" });
  expect(p.commit).toBe("abc123");
  expect(p.dataClass).toBe("SYNTHETIC");
  expect(JSON.stringify(p)).not.toContain("AUTH_SECRET");
});

it("flags the preview read-only DB session (DECISION-LEDGER #43)", () => {
  expect(healthPayload({ VERCEL_ENV: "preview" }).dbReadOnly).toBe(true);
  expect(healthPayload({ VERCEL_ENV: "production" }).dbReadOnly).toBe(false);
  expect(healthPayload({}).dbReadOnly).toBe(false);
});

it("dbEndpoint exposes only the ep- id, never credentials, host or query", async () => {
  const user = "synuser_q7"; const password = "SynPassw0rdNotReal9x";
  const env = {
    DATABASE_URL_UNPOOLED: `postgresql://${user}:${password}@ep-abc-123.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`,
    DATABASE_URL: `postgres://${user}:${password}@ep-abc-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
  };
  const p = healthPayload(env);
  expect(p.dbEndpoint).toBe("ep-abc-123");
  // Same check on the real route response body.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).text();
    expect(JSON.parse(body).dbEndpoint).toBe("ep-abc-123");
    for (const frag of [user, password, "@", "://", "postgres", "neon.tech", "sslmode", "neondb"]) expect(body).not.toContain(frag);
  } finally { process.env = saved; }
});

it("dbEndpoint falls back to DATABASE_URL (pooler suffix stripped) and is null when absent or not Neon", () => {
  expect(healthPayload({ DATABASE_URL: "postgres://u:p@ep-x-9-pooler.c-2.us-east-1.aws.neon.tech/db" }).dbEndpoint).toBe("ep-x-9");
  expect(healthPayload({}).dbEndpoint).toBeNull();
  expect(healthPayload({ DATABASE_URL: "postgres://u:p@localhost:5432/db" }).dbEndpoint).toBeNull();
  expect(healthPayload({ DATABASE_URL: "not a url" }).dbEndpoint).toBeNull();
});

/* ───────────────────────────── dbRole (DECISION-LEDGER row 53) ───────────────────────────── */

it("dbRole is the login role, read with one SELECT current_user and nothing else", async () => {
  expect(await readDbRole()).toBe("ppec_preview");
  expect(query.mock.calls).toEqual([[DB_ROLE_SQL, []]]);
  // Cheap and read-only-safe: a bare SELECT, no table, no transaction control, no SET.
  expect(DB_ROLE_SQL).toMatch(/^SELECT current_user AS role$/);
});

it("dbRole is null when the query fails, and health still answers ok", async () => {
  for (const failure of [new Error("connection refused"), new Error("permission denied for relation")]) {
    query.mockRejectedValueOnce(failure);
    expect(await readDbRole()).toBeNull();
  }
  query.mockRejectedValue(new Error("compute suspended"));
  const { GET } = await import("@/app/api/health/route");
  const res = await GET();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, dbRole: null });
});

it("dbRole is a role name or nothing: never a credential, a URL or a host", () => {
  expect(roleNameOf("ppec_preview")).toBe("ppec_preview");
  expect(roleNameOf("neondb_owner")).toBe("neondb_owner");
  for (const notARole of [
    "postgres://u:p@ep-abc-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
    "ep-abc-123.us-east-1.aws.neon.tech",
    "role with spaces",
    "a".repeat(64),
    "",
    undefined,
    null,
    42,
    { role: "ppec_preview" },
  ]) {
    expect(roleNameOf(notARole), String(notARole)).toBeNull();
  }
});

it("the response carries the role name and never the connection string behind it", async () => {
  const url = "postgres://ppec_preview:SynPassw0rdNotReal9x@ep-abc-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require";
  const saved = { ...process.env };
  Object.assign(process.env, { DATABASE_URL: url, DATABASE_URL_UNPOOLED: undefined, VERCEL_ENV: "preview" });
  try {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).text();
    expect(JSON.parse(body).dbRole).toBe("ppec_preview");
    expect(body).not.toContain(url);
    for (const frag of ["SynPassw0rdNotReal9x", "://", "@", "sslmode", "neon.tech", "neondb", "current_user"]) {
      expect(body, frag).not.toContain(frag);
    }

    // And a role column that somehow came back holding the URL is answered as null, not printed.
    query.mockResolvedValue({ rows: [{ role: url }] });
    const leaky = await (await GET()).text();
    expect(JSON.parse(leaky).dbRole).toBeNull();
    expect(leaky).not.toContain("SynPassw0rdNotReal9x");
  } finally { process.env = saved; }
});
