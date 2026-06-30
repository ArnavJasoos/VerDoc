import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, notifications } from "@verdoc/db";
import { protectedProcedure, router } from "../trpc";

export const notificationsRouter = router({
  // The caller's own notifications, newest first (own rows only — no leakage).
  list: protectedProcedure.query(({ ctx }) =>
    db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, ctx.user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(50),
  ),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ctx.user.id),
          isNull(notifications.readAt),
        ),
      );
    return rows.length;
  }),

  markRead: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, input.id),
            eq(notifications.userId, ctx.user.id),
          ),
        );
      return { ok: true };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, ctx.user.id),
          isNull(notifications.readAt),
        ),
      );
    return { ok: true };
  }),
});
