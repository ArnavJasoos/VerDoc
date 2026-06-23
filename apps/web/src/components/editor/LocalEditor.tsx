"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

/**
 * M0 editor: a local-only Tiptap instance. Content is NOT persisted yet —
 * real-time collaboration + Yjs persistence arrives in M1. Per plan §0, the
 * document body's single writer will be the Yjs doc, never a second store.
 */
export function LocalEditor() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: "<p>Start writing…</p>",
    immediatelyRender: false,
  });

  return <EditorContent editor={editor} />;
}
