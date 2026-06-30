import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Single shared pool. In Next dev the module is re-evaluated on HMR, so cache
// the pool on globalThis to avoid exhausting Postgres connections.
const globalForDb = globalThis as unknown as { __verdocPool?: Pool };
const pool = globalForDb.__verdocPool ?? new Pool({ connectionString });
if (process.env.NODE_ENV !== "production") globalForDb.__verdocPool = pool;

export const db = drizzle(pool, { schema });
export { schema };
export * from "./schema";
export * from "./rbac";
export * from "./authorize";
export * from "./seed";
