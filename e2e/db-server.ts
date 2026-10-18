/**
 * The app, against a throwaway local Postgres, for e2e/health-tab-data.spec.ts.
 *
 * `pnpm e2e` signs in with a role and no centre, so the Health tiles read zeros. This process
 * creates a database on the local cluster, applies drizzle/, seeds the three demo accounts and
 * one centre's vans and children, and starts `next start` without `E2E_DEMO_ROLE`. The Neon
 * driver cannot speak TCP, so a WebSocket proxy on 127.0.0.1 sits in front of that database
 * and nowhere else. The password is generated here and written to artifacts/health-db.json,
 * which is gitignored. Nothing in this file reads or writes a remote database.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { Client } from "pg";
import { DEMO_SITE_A, seedDemoUsers } from "../src/auth/seed";
import type { Exec } from "../src/domain/transition";
import { startPgWsProxy } from "./pg-ws-proxy";

const PORT = process.env.E2E_PORT ?? "3101";
const DB = "ppec_health_e2e";
const ROLE = "ppec_health_e2e";

function psql(sql: string): void {
  execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function applyMigrations(client: Client): Promise<void> {
  const dir = join(__dirname, "..", "drizzle");
  const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const entry of journal.entries) {
    const statements = readFileSync(join(dir, `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint");
    for (const statement of statements) {
      if (!statement.trim()) continue;
      try {
        await client.query(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${entry.tag} failed: ${message}\n${statement.slice(0, 240)}`);
      }
    }
  }
}

/** Three vans, V1 V2 V3, and five children. No setup rows, no plan, no tasks: the day reads 0/3. */
async function seedCentre(client: Client): Promise<void> {
  for (const label of ["V1", "V2", "V3"]) {
    await client.query(
      `INSERT INTO ops.vehicle (id, site_id, label, lift_equipped, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, true, 'seed', 'seed')`,
      [DEMO_SITE_A, label],
    );
  }
  for (let i = 1; i <= 5; i++) {
    const group = await client.query<{ id: string }>(
      `INSERT INTO ops.family_group (id, site_id, display_label, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, 'seed', 'seed') RETURNING id::text`,
      [DEMO_SITE_A, `F${i} (Demo)`],
    );
    await client.query(
      `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'seed', 'seed')`,
      [DEMO_SITE_A, group.rows[0]!.id, `SYN Child ${i}`],
    );
  }
}

async function main(): Promise<void> {
  const password = randomBytes(18).toString("hex");
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()`,
  );
  psql(`DROP DATABASE IF EXISTS ${DB}`);
  psql(`DROP ROLE IF EXISTS ${ROLE}`);
  psql(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' SUPERUSER`);
  psql(`CREATE DATABASE ${DB} OWNER ${ROLE}`);

  const databaseUrl = `postgres://${ROLE}:${password}@127.0.0.1:5432/${DB}?sslmode=disable`;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await applyMigrations(client);
  const exec: Exec = {
    async query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }> {
      const result = await client.query(sql, params);
      return { rows: result.rows as R[] };
    },
  };
  await seedDemoUsers(exec, { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1" }, { dryRun: false });
  await seedCentre(client);
  await client.end();

  const proxy = await startPgWsProxy(5432);
  const wsProxy = `127.0.0.1:${proxy.port}/v2`;
  neonConfig.wsProxy = wsProxy;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineConnect = false;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const smoke = await pool.query<{ n: number }>(
      "select count(*)::int as n from ops.vehicle where site_id = $1",
      [DEMO_SITE_A],
    );
    if (Number(smoke.rows[0]?.n) !== 3) throw new Error(`expected 3 vans, read ${smoke.rows[0]?.n}`);
  } finally {
    await pool.end();
  }

  mkdirSync("artifacts", { recursive: true });
  writeFileSync(join("artifacts", "health-db.json"), JSON.stringify({ databaseUrl }), { mode: 0o600 });

  const env = { ...process.env };
  delete env.E2E_DEMO_ROLE;
  delete env.VERCEL_ENV;
  env.APP_DATA_CLASS = "SYNTHETIC";
  env.DEMO_MODE = "1";
  env.DATABASE_URL = databaseUrl;
  env.LOCAL_PG_WS_PROXY = wsProxy;
  env.AUTH_SECRET = env.AUTH_SECRET || randomBytes(32).toString("hex");
  env.AUTH_TRUST_HOST = "true";

  const child = spawn("pnpm", ["exec", "next", "start", "--port", PORT, "--hostname", "127.0.0.1"], {
    env,
    stdio: "inherit",
  });
  const stop = () => {
    child.kill("SIGTERM");
    void proxy.close();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("exit", (code) => {
    void proxy.close();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
