import { drizzle } from "drizzle-orm/neon-serverless";
import { getPool } from "./pool";
import * as schema from "./schema";

export function getDb() {
  return drizzle(getPool(), { schema });
}
