import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  assignments,
  authorize,
  db,
  grantAssignment,
  roles,
  users,
} from "@verdoc/db";
import { protectedProcedure, router } from "../trpc";

// Resolve a user by email within the caller's org (no cross-org sharing).
async function findOrgUser(orgId: string, email: string) {
  const [u] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.email, email)))
    .limit(1);
  return u ?? null;
}

async function requireDocPermission(
  ctx: { user: { id: string; orgId: string } },
  docId: string,
  permission: "can_share" | "can_transfer_ownership",
) {
  const access = await authorize({
    userId: ctx.user.id,
    orgId: ctx.user.orgId,
    permission,
    scopeType: "document",
    scopeId: docId,
  });
  if (!access.allowed) throw new TRPCError({ code: "FORBIDDEN" });
}

export const assignmentsRouter = router({
  // Document-scope assignments, for the share dialog. Requires can_share.
  listForDocument: protectedProcedure
    .input(z.object({ docId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await requireDocPermission(ctx, input.docId, "can_share");
      return db
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          avatarColor: users.avatarColor,
          roleName: roles.name,
        })
        .from(assignments)
        .innerJoin(users, eq(assignments.userId, users.id))
        .innerJoin(roles, eq(assignments.roleId, roles.id))
        .where(
          and(
            eq(assignments.scopeType, "document"),
            eq(assignments.scopeId, input.docId),
          ),
        );
    }),

  // Grant (or update) a collaborator's role on a document. Requires can_share.
  // Owner is granted only via transferOwnership, not here.
  grant: protectedProcedure
    .input(
      z.object({
        docId: z.string().uuid(),
        email: z.string().email(),
        roleName: z.enum(["approver", "editor", "viewer"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireDocPermission(ctx, input.docId, "can_share");
      const target = await findOrgUser(ctx.user.orgId, input.email);
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No user with that email in your organization",
        });
      }
      await grantAssignment(db, {
        orgId: ctx.user.orgId,
        userId: target.id,
        roleName: input.roleName,
        scopeType: "document",
        scopeId: input.docId,
      });
      return { ok: true, userId: target.id };
    }),

  // Atomic ownership transfer (plan §6): grant the new owner, then demote the
  // caller to editor — both in one transaction so the doc is never owner-less
  // or double-owned.
  transferOwnership: protectedProcedure
    .input(z.object({ docId: z.string().uuid(), email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      await requireDocPermission(ctx, input.docId, "can_transfer_ownership");
      const target = await findOrgUser(ctx.user.orgId, input.email);
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No user with that email in your organization",
        });
      }
      if (target.id === ctx.user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You already own this document",
        });
      }
      await db.transaction(async (tx) => {
        await grantAssignment(tx, {
          orgId: ctx.user.orgId,
          userId: target.id,
          roleName: "owner",
          scopeType: "document",
          scopeId: input.docId,
        });
        // Demote the previous owner at this scope (a document-scope editor
        // assignment overrides any inherited org role for this doc).
        await grantAssignment(tx, {
          orgId: ctx.user.orgId,
          userId: ctx.user.id,
          roleName: "editor",
          scopeType: "document",
          scopeId: input.docId,
        });
      });
      return { ok: true };
    }),
});
