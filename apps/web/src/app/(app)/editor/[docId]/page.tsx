"use client";

import { use } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { LocalEditor } from "@/components/editor/LocalEditor";
import { trpc } from "@/lib/trpc";

export default function EditorPage({
  params,
}: {
  params: Promise<{ docId: string }>;
}) {
  const { docId } = use(params);
  const doc = trpc.documents.get.useQuery({ id: docId });

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
            <div className="editor-title">{doc.data.title}</div>
            <div className="banner">
              Local draft (M0). Real-time collaboration &amp; saving arrive in M1.
            </div>
            <LocalEditor />
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
