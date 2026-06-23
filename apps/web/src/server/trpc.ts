import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { ZodError } from "zod";
import { verifyAccessToken, type SessionUser } from "./auth";

export interface Context {
  user: SessionUser | null;
}

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<Context> {
  const auth = opts.req.headers.get("authorization");
  let user: SessionUser | null = null;
  if (auth?.startsWith("Bearer ")) {
    user = await verifyAccessToken(auth.slice("Bearer ".length));
  }
  return { user };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zod:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { user: ctx.user } });
});
