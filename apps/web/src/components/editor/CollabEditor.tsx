"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { env } from "@/env";
import { PresenceBar, type PresenceUser } from "./PresenceBar";

/**
 * M1 editor: the document body's single writer is the Yjs doc (plan §0). Tiptap
 * binds to a Y.Doc synced over Hocuspocus; nothing is mirrored into React state
 * or the documents row. The room id is the document id (plan §2.1).
 *
 * M2 presence (plan §9): the live name + color come from the session user via
 * the `user` prop — the one identity source (useSession). They flow into Yjs
 * awareness (cursors + the presence bar). No hardcoded/seed identity anywhere.
 *
 * Offline policy (plan §2.6): while disconnected the editor is read-only with a
 * clear banner — never a silently non-persisting editable doc.
 */
export function CollabEditor({
  docId,
  token,
  user,
}: {
  docId: string;
  token: string;
  user: PresenceUser;
}) {
  // One Y.Doc + provider per (docId, token). Recreated only if those change.
  const { ydoc, provider } = useMemo(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: env.NEXT_PUBLIC_COLLAB_URL,
      name: docId,
      token,
      document: ydoc,
    });
    return { ydoc, provider };
  }, [docId, token]);

  const [status, setStatus] = useState<WebSocketStatus>(
    WebSocketStatus.Connecting,
  );

  useEffect(() => {
    const onStatus = ({ status }: { status: WebSocketStatus }) =>
      setStatus(status);
    provider.on("status", onStatus);
    return () => {
      provider.off("status", onStatus);
      provider.destroy();
      ydoc.destroy();
    };
  }, [provider, ydoc]);

  const connected = status === WebSocketStatus.Connected;

  const editor = useEditor(
    {
      extensions: [
        // Collaboration ships its own undo/redo history (Yjs UndoManager); the
        // StarterKit one must be disabled or the two conflict.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
        // Renders remote carets + selections; publishes our name/color into Yjs
        // awareness so other clients see us (plan §9).
        CollaborationCursor.configure({
          provider,
          user: { name: user.name, color: user.color },
        }),
      ],
      editable: connected,
      immediatelyRender: false,
    },
    [provider, ydoc],
  );

  useEffect(() => {
    editor?.setEditable(connected);
  }, [editor, connected]);

  return (
    <>
      <PresenceBar provider={provider} self={user} />
      {!connected && (
        <div className="banner">
          {status === WebSocketStatus.Connecting
            ? "Connecting… editing is paused until the document loads."
            : "Reconnecting… changes are paused."}
        </div>
      )}
      <EditorContent editor={editor} />
    </>
  );
}
