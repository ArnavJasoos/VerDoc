"use client";

import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

interface Peer {
  clientId: number;
  name: string;
  color: string;
  isSelf: boolean;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Live collaborator avatars, read from Yjs awareness (plan §9). CollaborationCursor
 * publishes each client's { name, color } into awareness; we read every present
 * client and tag our own with "(you)". Identity originates from the session user
 * (`self`) — never a hardcoded roster.
 */
export function PresenceBar({
  provider,
  self,
}: {
  provider: HocuspocusProvider;
  self: PresenceUser;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;

    const sync = () => {
      const next: Peer[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        const u = (state as { user?: { name?: string; color?: string } }).user;
        if (!u?.name || !u?.color) continue;
        next.push({
          clientId,
          name: u.name,
          color: u.color,
          isSelf: clientId === awareness.clientID,
        });
      }
      // Self first, then others by clientId for a stable order.
      next.sort((a, b) =>
        a.isSelf === b.isSelf ? a.clientId - b.clientId : a.isSelf ? -1 : 1,
      );
      setPeers(next);
    };

    sync();
    awareness.on("change", sync);
    return () => awareness.off("change", sync);
  }, [provider]);

  if (peers.length === 0) return null;

  return (
    <div className="presence">
      {peers.map((p) => (
        <span
          key={p.clientId}
          className="presence-chip"
          title={p.isSelf ? `${self.name} (you)` : p.name}
        >
          <span className="avatar" style={{ background: p.color }}>
            {initials(p.name)}
          </span>
          <span className="presence-name">
            {p.name}
            {p.isSelf ? " (you)" : ""}
          </span>
        </span>
      ))}
    </div>
  );
}
