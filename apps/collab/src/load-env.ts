import { config } from "dotenv";
import path from "node:path";

// The repo-root .env is the single source of truth (plan §12) and carries the
// SHARED AUTH_JWT_SECRET so this collab server trusts the same identity the web
// API issues (plan §4). Loaded before @verdoc/db is imported so DATABASE_URL is
// present when its pool initializes. Collab dev runs with cwd = apps/collab.
config({ path: path.resolve(process.cwd(), "../../.env") });
