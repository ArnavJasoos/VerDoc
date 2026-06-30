"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";

const TEXT: Record<string, string> = {
  submitted: "submitted a document for approval",
  approved: "approved your document",
  rejected: "requested changes on your document",
};

/** Bell showing unread count + the caller's recent notifications (plan §3). */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const unread = trpc.notifications.unreadCount.useQuery(undefined, {
    refetchInterval: 15000,
  });
  const list = trpc.notifications.list.useQuery(undefined, { enabled: open });
  const markAll = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => {
      void utils.notifications.invalidate();
    },
  });

  const count = unread.data ?? 0;

  return (
    <div className="bell-wrap">
      <button
        className="btn secondary"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
      >
        🔔{count > 0 && <span className="bell-badge">{count}</span>}
      </button>
      {open && (
        <div className="bell-menu">
          <div className="row" style={{ margin: "0 0 8px" }}>
            <strong>Notifications</strong>
            {count > 0 && (
              <button
                className="btn secondary"
                style={{ fontSize: 11, padding: "2px 8px" }}
                onClick={() => markAll.mutate()}
              >
                Mark all read
              </button>
            )}
          </div>
          {list.data?.length ? (
            list.data.map((n) => {
              const p = n.payload as { title?: string };
              return (
                <div
                  key={n.id}
                  className={`bell-item ${n.readAt ? "" : "unread"}`}
                >
                  <span>{TEXT[n.type] ?? n.type}</span>
                  {p.title && <span className="muted-label"> · {p.title}</span>}
                </div>
              );
            })
          ) : (
            <p className="muted-label">Nothing yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
