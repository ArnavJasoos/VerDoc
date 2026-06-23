import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, documents } from "@verdoc/db";
import { protectedProcedure, router } from "../trpc";

export const documentsRouter = router({
  // Org-scoped list, newest first. Every query filters by org_id (plan §6).
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select({
        id: documents.id,
        title: documents.title,
        status: documents.status,
        updatedAt: documents.updatedAt,
        createdAt: documents.createdAt,
        lastEditorId: documents.lastEditorId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.orgId, ctx.user.orgId),
          eq(documents.trashed, false),
        ),
      )
      .orderBy(desc(documents.updatedAt));
  }),

  create: protectedProcedure
    .input(z.object({ title: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const [doc] = await db
        .insert(documents)
        .values({
          orgId: ctx.user.orgId,
          title: input.title?.trim() || "Untitled",
          createdBy: ctx.user.id,
          lastEditorId: ctx.user.id,
        })
        .returning();
      return doc!;
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [doc] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.id), eq(documents.orgId, ctx.user.orgId)),
        )
        .limit(1);
      if (!doc) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return doc;
    }),
});
