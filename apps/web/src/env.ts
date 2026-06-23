import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// Single typed source for env. Fails fast on missing/invalid vars (plan §12).
export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    AUTH_JWT_SECRET: z.string().min(16),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  emptyStringAsUndefined: true,
});
