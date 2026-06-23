import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, organizations, users } from "@verdoc/db";
import {
  clearRefreshCookie,
  endSession,
  hashPassword,
  loadSessionUser,
  rotateSession,
  signAccessToken,
  startSession,
  verifyPassword,
  type SessionUser,
} from "../auth";
import { protectedProcedure, publicProcedure, router } from "../trpc";

const credentials = {
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
};

function avatarColor(seed: string): string {
  const palette = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444"];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

export const authRouter = router({
  signup: publicProcedure
    .input(
      z.object({
        ...credentials,
        displayName: z.string().min(1).max(80),
        orgName: z.string().min(1).max(80).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // M0: each signup creates its own org (creator owns). Joining shared orgs
      // is M3 (RBAC + sharing).
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An account with this email already exists",
        });
      }

      const result = await db.transaction(async (tx) => {
        const [org] = await tx
          .insert(organizations)
          .values({ name: input.orgName ?? `${input.displayName}'s workspace` })
          .returning();
        const [user] = await tx
          .insert(users)
          .values({
            orgId: org!.id,
            email: input.email,
            displayName: input.displayName,
            avatarColor: avatarColor(input.email),
            passwordHash: await hashPassword(input.password),
          })
          .returning();
        return user!;
      });

      const sessionUser: SessionUser = {
        id: result.id,
        orgId: result.orgId,
        email: result.email,
        displayName: result.displayName,
        avatarColor: result.avatarColor,
      };
      await startSession(sessionUser.id);
      return { user: sessionUser, accessToken: await signAccessToken(sessionUser) };
    }),

  login: publicProcedure
    .input(z.object(credentials))
    .mutation(async ({ input }) => {
      const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.email, input.email), eq(users.status, "active")))
        .limit(1);
      const ok = user
        ? await verifyPassword(input.password, user.passwordHash)
        : false;
      if (!user || !ok) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid email or password",
        });
      }
      const sessionUser: SessionUser = {
        id: user.id,
        orgId: user.orgId,
        email: user.email,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
      };
      await startSession(sessionUser.id);
      return { user: sessionUser, accessToken: await signAccessToken(sessionUser) };
    }),

  // Called by the client on load: rotates the refresh cookie and returns a
  // fresh access token. {user:null} means "logged out".
  refresh: publicProcedure.mutation(async () => {
    const userId = await rotateSession();
    if (!userId) return { user: null, accessToken: null } as const;
    const user = await loadSessionUser(userId);
    if (!user) {
      await clearRefreshCookie();
      return { user: null, accessToken: null } as const;
    }
    return { user, accessToken: await signAccessToken(user) } as const;
  }),

  me: protectedProcedure.query(({ ctx }) => ctx.user),

  logout: publicProcedure.mutation(async () => {
    await endSession();
    return { ok: true };
  }),
});
