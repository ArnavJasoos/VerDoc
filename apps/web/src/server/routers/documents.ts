import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { aliasedTable, and, desc, eq } from "drizzle-orm";
import { db, documents, users } from "@verdoc/db";
import { protectedProcedure, router } from "../trpc";

const lastEditor = aliasedTable(users, "last_editor");

export const documentsRouter = router({
  // Org-scoped list, newest first. Every query filters by org_id (plan §6).
  // The collab server's onStoreDocument keeps updated_at / last_editor_id fresh,
  // so cards show accurate "edited Nh ago by X" (plan §2.5). lastEditorName is a
  // derived read-model field — joined here, never stored on the documents row.
  list: protectedProcedure.query(async ({ ctx }) => {
    return db
      .select({
        id: documents.id,
        title: documents.title,
        status: documents.status,
        updatedAt: documents.updatedAt,
        createdAt: documents.createdAt,
        lastEditorId: documents.lastEditorId,
        lastEditorName: lastEditor.displayName,
      })
      .from(documents)
      .leftJoin(lastEditor, eq(documents.lastEditorId, lastEditor.id))
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
