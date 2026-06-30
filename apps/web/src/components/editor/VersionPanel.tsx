"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";

interface Access {
  canSubmit: boolean;
  canApprove: boolean;
  canViewHistory: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  working: "Working",
  pending_approval: "Pending approval",
  approved: "Approved",
};

/**
 * Approval actions + version history + two-snapshot diff (plan §2.3/§2.4). All
 * transitions go through the server (versionsService owns documents.status);
 * the buttons shown are display-gated by the resolved role.
 */
export function VersionPanel({
  docId,
  status,
  access,
  onChanged,
}: {
  docId: string;
  status: string;
  access: Access;
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const history = trpc.versions.history.useQuery(
    { docId },
    { enabled: access.canViewHistory },
  );
  const [pair, setPair] = useState<{ before?: string; after?: string }>({});
  const diff = trpc.versions.diff.useQuery(
    { docId, beforeVersionId: pair.before!, afterVersionId: pair.after! },
    { enabled: !!pair.before && !!pair.after },
  );

  const after = () => {
    onChanged();
    void utils.versions.history.invalidate({ docId });
    void utils.notifications.invalidate();
  };
  const submit = trpc.versions.submit.useMutation({ onSuccess: after });
  const approve = trpc.versions.approve.useMutation({ onSuccess: after });
  const reject = trpc.versions.reject.useMutation({ onSuccess: after });

  const err =
    submit.error?.message ?? approve.error?.message ?? reject.error?.message;

  return (
    <div className="version-panel">
      <div className="row" style={{ marginBottom: 10 }}>
        <span className={`status-badge status-${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
        <div className="who">
          {access.canSubmit && status === "working" && (
            <button
              className="btn"
              style={{ width: "auto" }}
              disabled={submit.isPending}
              onClick={() => submit.mutate({ docId })}
            >
              Submit for approval
            </button>
          )}
          {access.canApprove && status === "pending_approval" && (
            <>
              <button
                className="btn"
                style={{ width: "auto" }}
                disabled={approve.isPending}
                onClick={() => approve.mutate({ docId })}
              >
                Approve
              </button>
              <button
                className="btn secondary"
                disabled={reject.isPending}
                onClick={() => {
                  const note =
                    window.prompt("Reason for rejection (optional):") ??
                    undefined;
                  reject.mutate({ docId, recommendation: note });
                }}
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>
      {err && <p className="error">{err}</p>}

      {access.canViewHistory && (
        <div className="history">
          <div className="muted-label">Version history</div>
          {history.data?.length ? (
            <table className="history-table">
              <tbody>
                {history.data.map((v) => (
                  <tr key={v.id}>
                    <td>v{v.versionNo}</td>
                    <td>
                      <span className={`kind-badge kind-${v.kind}`}>
                        {v.kind}
                      </span>
                    </td>
                    <td className="muted-label">
                      {new Date(v.createdAt).toLocaleString()}
                    </td>
                    <td>
                      <label>
                        <input
                          type="radio"
                          name="before"
                          onChange={() =>
                            setPair((p) => ({ ...p, before: v.id }))
                          }
                        />{" "}
                        A
                      </label>
                    </td>
                    <td>
                      <label>
                        <input
                          type="radio"
                          name="after"
                          onChange={() =>
                            setPair((p) => ({ ...p, after: v.id }))
                          }
                        />{" "}
                        B
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted-label">No versions yet.</p>
          )}

          {pair.before && pair.after && (
            <div className="diff-view">
              <div className="muted-label">Compare A → B</div>
              {diff.isLoading ? (
                <p className="muted-label">Computing…</p>
              ) : (
                <pre className="diff">
                  {diff.data?.map((l, i) => (
                    <div key={i} className={`diff-${l.type}`}>
                      {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
                      {l.text}
                    </div>
                  ))}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
