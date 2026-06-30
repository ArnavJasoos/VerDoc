"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";
import { env } from "@/env";

/**
 * M1 editor: the document body's single writer is the Yjs doc (plan §0). Tiptap
 * binds to a Y.Doc synced over Hocuspocus; nothing is mirrored into React state
 * or the documents row. The room id is the document id (plan §2.1).
 *
 * Offline policy (plan §2.6): while disconnected the editor is read-only with a
 * clear banner — never a silently non-persisting editable doc.
 */
export function CollabEditor({
  docId,
  token,
}: {
  docId: string;
  token: string;
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
        // Collaboration ships its own undo/redo history; StarterKit's must be
        // disabled or the two histories conflict.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
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
