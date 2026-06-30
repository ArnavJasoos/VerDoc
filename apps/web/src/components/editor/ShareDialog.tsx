"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";

const SHAREABLE_ROLES = ["viewer", "editor", "approver"] as const;

/**
 * Share dialog — grants document-scope assignments and transfers ownership
 * (plan §6). Every action is server-authorized (can_share / can_transfer_
 * ownership); this UI only renders for users the server says may manage sharing.
 */
export function ShareDialog({
  docId,
  onClose,
}: {
  docId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const list = trpc.assignments.listForDocument.useQuery({ docId });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof SHAREABLE_ROLES)[number]>("viewer");

  const refresh = () => {
    void utils.assignments.listForDocument.invalidate({ docId });
    void utils.documents.myAccess.invalidate({ id: docId });
  };
  const grant = trpc.assignments.grant.useMutation({
    onSuccess: () => {
      setEmail("");
      refresh();
    },
  });
  const transfer = trpc.assignments.transferOwnership.useMutation({
    onSuccess: refresh,
  });

  const err = grant.error?.message ?? transfer.error?.message;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3 style={{ margin: 0 }}>Share document</h3>
          <button className="btn secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="share-form">
          <input
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as (typeof SHAREABLE_ROLES)[number])
            }
          >
            {SHAREABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            className="btn"
            style={{ width: "auto" }}
            disabled={!email || grant.isPending}
            onClick={() => grant.mutate({ docId, email, roleName: role })}
          >
            {grant.isPending ? "Sharing…" : "Share"}
          </button>
        </div>
        {err && <p className="error">{err}</p>}

        <div className="share-list">
          {list.data?.map((a) => (
            <div key={a.userId} className="share-row">
              <span
                className="avatar"
                style={{ background: a.avatarColor, width: 24, height: 24 }}
              >
                {a.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span style={{ flex: 1 }}>{a.displayName}</span>
              <span className="role-badge">{a.roleName}</span>
              {a.roleName !== "owner" && (
                <button
                  className="btn secondary"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  disabled={transfer.isPending}
                  onClick={() =>
                    transfer.mutate({ docId, email: a.email })
                  }
                  title="Transfer ownership to this collaborator"
                >
                  Make owner
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
