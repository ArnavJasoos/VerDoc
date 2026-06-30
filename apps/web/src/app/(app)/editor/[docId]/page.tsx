"use client";

import { use, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { CollabEditor } from "@/components/editor/CollabEditor";
import { ShareDialog } from "@/components/editor/ShareDialog";
import { useSession } from "@/lib/session";
import { tokenStore, trpc } from "@/lib/trpc";

export default function EditorPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);
  const doc = trpc.documents.get.useQuery({ id: docId });
  // Display-only access info (plan §6): the server already enforces every
  // mutation + the collab connection; this just decides which controls to show.
  const access = trpc.documents.myAccess.useQuery({ id: docId });
  // Identity comes from the one session source (plan §8); presence uses it.
  const { user } = useSession();
  // AppShell already gates on a loaded session, so the access token is normally
  // present here. Guard anyway: never mount the collab editor with a blank token
  // (it would auth-fail on the server and sit "Connecting…" forever).
  const token = tokenStore.get();
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <AppShell>
      <div className="editor-wrap">
        <p style={{ marginBottom: 16 }}>
          <Link href="/browser">← All documents</Link>
        </p>
        {doc.isLoading ? (
          <p className="empty">Loading…</p>
        ) : doc.error ? (
          <p className="error">{doc.error.message}</p>
        ) : doc.data ? (
          <>
            <div className="row">
              <div className="editor-title" style={{ marginBottom: 0 }}>
                {doc.data.title}
              </div>
              <div className="who">
                {access.data?.role && (
                  <span className="role-badge">{access.data.role}</span>
                )}
                {access.data?.canShare && (
                  <button
                    className="btn secondary"
                    onClick={() => setShareOpen(true)}
                  >
                    Share
                  </button>
                )}
              </div>
            </div>
            {token && user ? (
              <CollabEditor
                docId={docId}
                token={token}
                user={{
                  id: user.id,
                  name: user.displayName,
                  color: user.avatarColor,
                }}
              />
            ) : (
              <p className="error">
                Your session expired. <Link href="/login">Sign in again</Link>{" "}
                to keep editing.
              </p>
            )}
            {shareOpen && (
              <ShareDialog docId={docId} onClose={() => setShareOpen(false)} />
            )}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
