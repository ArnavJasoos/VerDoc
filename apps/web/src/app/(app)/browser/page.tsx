"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { trpc } from "@/lib/trpc";

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function BrowserPage() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const docs = trpc.documents.list.useQuery();

  const create = trpc.documents.create.useMutation({
    onSuccess: async (doc) => {
      await utils.documents.list.invalidate();
      router.push(`/editor/${doc.id}`);
    },
  });

  return (
    <AppShell>
      <div className="container">
        <div className="row">
          <h2 style={{ margin: 0 }}>Documents</h2>
          <button
            className="btn"
            style={{ width: "auto" }}
            onClick={() => create.mutate({})}
            disabled={create.isPending}
          >
            {create.isPending ? "Creating…" : "+ New document"}
          </button>
        </div>

        {docs.isLoading ? (
          <p className="empty">Loading documents…</p>
        ) : docs.data && docs.data.length > 0 ? (
          <div className="doc-list">
            {docs.data.map((d) => (
              <Link key={d.id} href={`/editor/${d.id}`} className="doc-card">
                <div className="title">{d.title}</div>
                <div className="meta">
                  {d.status} · edited {timeAgo(new Date(d.updatedAt))}
                  {d.lastEditorName ? ` by ${d.lastEditorName}` : ""}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="empty">
            No documents yet. Create your first one to get started.
          </p>
        )}
      </div>
    </AppShell>
  );
}
