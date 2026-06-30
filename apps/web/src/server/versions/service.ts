import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import {
  assignments,
  authorize,
  db,
  documents,
  notifications,
  recommendations,
  roles,
  versions,
  ydocState,
  type VersionKind,
} from "@verdoc/db";
import { decodeDocText } from "./yjs-text";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
interface Actor {
  id: string;
  orgId: string;
}

// Load a document within the actor's org or fail (no cross-org). FOR UPDATE
// locks the row for the transaction so concurrent transitions serialize — no
// duplicate version_no / no double-guard-pass under READ COMMITTED.
async function loadDoc(tx: Tx, docId: string, orgId: string) {
  const [doc] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.orgId, orgId)))
    .limit(1)
    .for("update");
  if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
  return doc;
}

// Materialize the current Yjs state as an immutable, append-only version row
// (plan §2.3). Bumps documents.current_version_no.
async function snapshot(
  tx: Tx,
  doc: { id: string; currentVersionNo: number },
  kind: VersionKind,
  userId: string,
) {
  const [row] = await tx
    .select({ state: ydocState.state })
    .from(ydocState)
    .where(eq(ydocState.documentId, doc.id))
    .limit(1);
  const blob = row?.state ?? Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
  const versionNo = doc.currentVersionNo + 1;

  const [version] = await tx
    .insert(versions)
    .values({
      documentId: doc.id,
      versionNo,
      kind,
      ydocSnapshot: blob,
      createdBy: userId,
      meta: { plainText: decodeDocText(blob) },
    })
    .returning();
  // Caller updates documents.current_version_no together with the status
  // transition (one UPDATE per transition).
  return version!;
}

// Users who can approve this document (owner/approver at org or document scope),
// excluding the submitter — they receive the "submitted for approval" notice.
async function approverIds(
  tx: Tx,
  orgId: string,
  docId: string,
  excludeUserId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ userId: assignments.userId, role: roles.name })
    .from(assignments)
    .innerJoin(roles, eq(assignments.roleId, roles.id))
    .where(
      and(
        eq(assignments.orgId, orgId),
        inArray(roles.name, ["owner", "approver"]),
        inArray(assignments.scopeId, [orgId, docId]),
        inArray(assignments.scopeType, ["organization", "document"]),
      ),
    );
  return [
    ...new Set(rows.map((r) => r.userId).filter((id) => id !== excludeUserId)),
  ];
}

async function requirePermission(
  actor: Actor,
  docId: string,
  permission: "can_submit" | "can_approve" | "can_view_history",
) {
  const access = await authorize({
    userId: actor.id,
    orgId: actor.orgId,
    permission,
    scopeType: "document",
    scopeId: docId,
  });
  if (!access.allowed) throw new TRPCError({ code: "FORBIDDEN" });
}

/**
 * versionsService — the ONLY owner of documents.status (plan §2.4). Each
 * transition does snapshot + status change + notify in one transaction, so the
 * three can never drift apart.
 */
export const versionsService = {
  // working ──submit──▶ pending_approval
  async submit(actor: Actor, docId: string) {
    await requirePermission(actor, docId, "can_submit");
    return db.transaction(async (tx) => {
      const doc = await loadDoc(tx, docId, actor.orgId);
      if (doc.status !== "working") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot submit a document that is ${doc.status}`,
        });
      }
      // Guard the stuck state: don't move to pending_approval if no one can
      // approve it (would be unapprovable AND un-trashable).
      const approvers = await approverIds(tx, actor.orgId, docId, actor.id);
      if (approvers.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No approver is available to review this document",
        });
      }

      const version = await snapshot(tx, doc, "submission", actor.id);
      await tx
        .update(documents)
        .set({ status: "pending_approval", currentVersionNo: version.versionNo })
        .where(eq(documents.id, docId));

      await tx.insert(notifications).values(
        approvers.map((userId) => ({
          userId,
          documentId: docId,
          type: "submitted",
          payload: { versionId: version.id, byUserId: actor.id, title: doc.title },
        })),
      );
      return { status: "pending_approval" as const, versionId: version.id };
    });
  },

  // pending_approval ──approve──▶ approved (notify submitter)
  async approve(actor: Actor, docId: string) {
    await requirePermission(actor, docId, "can_approve");
    return db.transaction(async (tx) => {
      const doc = await loadDoc(tx, docId, actor.orgId);
      if (doc.status !== "pending_approval") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Document is not pending approval",
        });
      }
      const [submission] = await tx
        .select({ createdBy: versions.createdBy })
        .from(versions)
        .where(and(eq(versions.documentId, docId), eq(versions.kind, "submission")))
        .orderBy(desc(versions.versionNo))
        .limit(1);

      const version = await snapshot(tx, doc, "approved", actor.id);
      await tx
        .update(documents)
        .set({ status: "approved", currentVersionNo: version.versionNo })
        .where(eq(documents.id, docId));

      if (submission && submission.createdBy !== actor.id) {
        await tx.insert(notifications).values({
          userId: submission.createdBy,
          documentId: docId,
          type: "approved",
          payload: { versionId: version.id, byUserId: actor.id, title: doc.title },
        });
      }
      return { status: "approved" as const, versionId: version.id };
    });
  },

  // pending_approval ──reject──▶ working (+ recommendation, notify submitter)
  async reject(actor: Actor, docId: string, recommendation?: string) {
    await requirePermission(actor, docId, "can_approve");
    return db.transaction(async (tx) => {
      const doc = await loadDoc(tx, docId, actor.orgId);
      if (doc.status !== "pending_approval") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Document is not pending approval",
        });
      }
      const [submission] = await tx
        .select({ id: versions.id, createdBy: versions.createdBy })
        .from(versions)
        .where(and(eq(versions.documentId, docId), eq(versions.kind, "submission")))
        .orderBy(desc(versions.versionNo))
        .limit(1);

      await tx
        .update(documents)
        .set({ status: "working" })
        .where(eq(documents.id, docId));

      const body = recommendation?.trim();
      if (submission && body) {
        await tx.insert(recommendations).values({
          versionId: submission.id,
          authorId: actor.id,
          body,
        });
      }
      if (submission && submission.createdBy !== actor.id) {
        await tx.insert(notifications).values({
          userId: submission.createdBy,
          documentId: docId,
          type: "rejected",
          payload: { byUserId: actor.id, title: doc.title, recommendation: body ?? null },
        });
      }
      return { status: "working" as const };
    });
  },

  async history(actor: Actor, docId: string) {
    await requirePermission(actor, docId, "can_view_history");
    return db
      .select({
        id: versions.id,
        versionNo: versions.versionNo,
        kind: versions.kind,
        createdAt: versions.createdAt,
        createdBy: versions.createdBy,
      })
      .from(versions)
      .where(eq(versions.documentId, docId))
      .orderBy(desc(versions.versionNo));
  },

  async getText(actor: Actor, docId: string, versionId: string) {
    await requirePermission(actor, docId, "can_view_history");
    const [v] = await db
      .select({ meta: versions.meta, documentId: versions.documentId })
      .from(versions)
      .where(eq(versions.id, versionId))
      .limit(1);
    if (!v || v.documentId !== docId) throw new TRPCError({ code: "NOT_FOUND" });
    return v.meta.plainText ?? "";
  },
};
