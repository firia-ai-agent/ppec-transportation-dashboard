import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

let pool: Pool | undefined;

/** Pooled connection (ADR-009). Never log the URL. */
export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new Pool({ connectionString: url });
  return drizzle(pool, { schema });
}
