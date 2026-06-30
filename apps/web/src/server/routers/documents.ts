import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { aliasedTable, and, desc, eq, inArray } from "drizzle-orm";
import {
  assignments,
  authorize,
  db,
  documents,
  grantAssignment,
  ROLE_PERMISSIONS,
  users,
  type PermissionKey,
  type RoleName,
} from "@verdoc/db";
import { protectedProcedure, router } from "../trpc";

const lastEditor = aliasedTable(users, "last_editor");

export const documentsRouter = router({
  // Org-scoped list, newest first, filtered to documents the user can actually
  // see (plan §6): an org-level assignment sees everything in the org; otherwise
  // only documents explicitly shared with the user. Cross-org never appears.
  list: protectedProcedure.query(async ({ ctx }) => {
    const mine = await db
      .select({ scopeType: assignments.scopeType, scopeId: assignments.scopeId })
      .from(assignments)
      .where(
        and(
          eq(assignments.userId, ctx.user.id),
          eq(assignments.orgId, ctx.user.orgId),
        ),
      );
    const hasOrgWide = mine.some((a) => a.scopeType === "organization");
    const sharedDocIds = mine
      .filter((a) => a.scopeType === "document")
      .map((a) => a.scopeId);

    const base = db
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
      .leftJoin(lastEditor, eq(documents.lastEditorId, lastEditor.id));

    if (hasOrgWide) {
      return base
        .where(
          and(
            eq(documents.orgId, ctx.user.orgId),
            eq(documents.trashed, false),
          ),
        )
        .orderBy(desc(documents.updatedAt));
    }
    if (sharedDocIds.length === 0) return [];
    return base
      .where(
        and(
          eq(documents.orgId, ctx.user.orgId),
          eq(documents.trashed, false),
          inArray(documents.id, sharedDocIds),
        ),
      )
      .orderBy(desc(documents.updatedAt));
  }),

  create: protectedProcedure
    .input(z.object({ title: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values({
            orgId: ctx.user.orgId,
            title: input.title?.trim() || "Untitled",
            createdBy: ctx.user.id,
            lastEditorId: ctx.user.id,
          })
          .returning();
        // Creator owns the new document (plan §6) — enables later sharing and
        // atomic ownership transfer at the document scope.
        await grantAssignment(tx, {
          orgId: ctx.user.orgId,
          userId: ctx.user.id,
          roleName: "owner",
          scopeType: "document",
          scopeId: doc!.id,
        });
        return doc!;
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Server is the gate (plan §6). NOT_FOUND on denial avoids leaking the
      // existence of documents the user can't see.
      const access = await authorize({
        userId: ctx.user.id,
        orgId: ctx.user.orgId,
        permission: "can_view",
        scopeType: "document",
        scopeId: input.id,
      });
      if (!access.allowed) throw new TRPCError({ code: "NOT_FOUND" });

      const [doc] = await db
        .select()
        .from(documents)
        .where(
          and(eq(documents.id, input.id), eq(documents.orgId, ctx.user.orgId)),
        )
        .limit(1);
      if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
      return doc;
    }),

  // Trash a document. Requires can_delete, and is blocked while the doc is
  // pending approval (plan §2.4 guard rail).
  trash: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const access = await authorize({
        userId: ctx.user.id,
        orgId: ctx.user.orgId,
        permission: "can_delete",
        scopeType: "document",
        scopeId: input.id,
      });
      if (!access.allowed) throw new TRPCError({ code: "FORBIDDEN" });

      const [doc] = await db
        .select({ status: documents.status })
        .from(documents)
        .where(
          and(eq(documents.id, input.id), eq(documents.orgId, ctx.user.orgId)),
        )
        .limit(1);
      if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
      if (doc.status === "pending_approval") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot trash a document while it is pending approval",
        });
      }
      await db
        .update(documents)
        .set({ trashed: true })
        .where(eq(documents.id, input.id));
      return { ok: true };
    }),

  // Read-only access descriptor that drives UI display ONLY (plan §6). The real
  // enforcement is on each mutating call + the collab server, never here.
  myAccess: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const access = await authorize({
        userId: ctx.user.id,
        orgId: ctx.user.orgId,
        permission: "can_view",
        scopeType: "document",
        scopeId: input.id,
      });
      const role = access.resolvedRole;
      const perms: readonly PermissionKey[] = role
        ? ROLE_PERMISSIONS[role as RoleName]
        : [];
      const can = (k: PermissionKey) => perms.includes(k);
      return {
        role,
        viaScope: access.viaScope,
        canView: can("can_view"),
        canEdit: can("can_edit"),
        canComment: can("can_comment"),
        canSubmit: can("can_submit"),
        canApprove: can("can_approve"),
        canViewHistory: can("can_view_history"),
        canShare: can("can_share"),
        canTransferOwnership: can("can_transfer_ownership"),
      };
    }),
});
