import "./load-env";

import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { authorize, db, documents, ydocState } from "@verdoc/db";

const PORT = Number(process.env.COLLAB_PORT ?? 1234);

const secretRaw = process.env.AUTH_JWT_SECRET;
if (!secretRaw) throw new Error("AUTH_JWT_SECRET is not set (expected in repo-root .env)");
const secret = new TextEncoder().encode(secretRaw);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Identity carried from onAuthenticate into the store hook (plan §2.5: store
// stamps last_editor_id). One room == one document id.
interface CollabContext {
  userId: string;
  orgId: string;
}

const server = Server.configure({
  port: PORT,
  // The collab server validates the SAME access JWT the web API issues
  // (plan §4 shared secret), then runs the SAME authorize() gate as the API
  // (plan §6). This is the real "viewer cannot edit" boundary: a user without
  // can_edit connects read-only; without can_view they cannot connect at all.
  async onAuthenticate({
    token,
    documentName,
    connection,
  }): Promise<CollabContext> {
    if (!UUID_RE.test(documentName)) throw new Error("Invalid room");

    let sub: string | undefined;
    let orgId: string;
    try {
      const { payload } = await jwtVerify(token, secret);
      sub = payload.sub;
      // orgId is trusted from the short-lived access-token claim (set at
      // issuance). OK for one-org-per-user. TODO: if org membership can change,
      // an outstanding access token carries a stale orgId — re-derive from the
      // DB user row, or invalidate tokens on change.
      orgId = String(payload.orgId);
    } catch {
      throw new Error("Unauthorized");
    }
    if (!sub) throw new Error("Unauthorized");

    // authorize() denies cross-org / missing documents, so tenant isolation is
    // covered here too.
    const canView = await authorize({
      userId: sub,
      orgId,
      permission: "can_view",
      scopeType: "document",
      scopeId: documentName,
    });
    if (!canView.allowed) throw new Error("Forbidden");

    const canEdit = await authorize({
      userId: sub,
      orgId,
      permission: "can_edit",
      scopeType: "document",
      scopeId: documentName,
    });
    // Read-only viewers stay connected (live updates) but cannot write back.
    if (!canEdit.allowed) connection.readOnly = true;

    return { userId: sub, orgId };
  },

  extensions: [
    new Database({
      // Restore the room from the persisted Yjs blob (plan §2.1). null => the
      // room starts empty (a brand-new document).
      async fetch({ documentName }) {
        const [row] = await db
          .select({ state: ydocState.state })
          .from(ydocState)
          .where(eq(ydocState.documentId, documentName))
          .limit(1);
        return row?.state ?? null;
      },

      // Persist the Yjs blob AND refresh document metadata in one transaction:
      // updated_at + last_editor_id so lists show "edited Nh ago by X"
      // (plan §2.5). The body never touches the documents row (one-writer, §0).
      async store({ documentName, state, context }) {
        const ctx = context as CollabContext;
        const blob = Buffer.from(state);
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx
            .insert(ydocState)
            .values({ documentId: documentName, state: blob, updatedAt: now })
            .onConflictDoUpdate({
              target: ydocState.documentId,
              set: { state: blob, updatedAt: now },
            });
          await tx
            .update(documents)
            .set({ updatedAt: now, lastEditorId: ctx.userId })
            .where(eq(documents.id, documentName));
        });
      },
    }),
  ],
});

server.listen().then(() => {
  // eslint-disable-next-line no-console
  console.log(`[collab] Hocuspocus listening on ws://localhost:${PORT}`);
});
