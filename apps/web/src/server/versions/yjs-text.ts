import * as Y from "yjs";

// Tiptap/ProseMirror stores the document body in a Y.XmlFragment named "default".
// We extract plain text from a snapshot blob to build the derived read-model
// (plan §2.2) used for version diffing — the blob stays the source of truth.
function fragmentText(node: Y.XmlElement | Y.XmlFragment): string {
  let out = "";
  node.forEach((child) => {
    if (child instanceof Y.XmlText) {
      out += child.toString();
    } else if (child instanceof Y.XmlElement) {
      out += fragmentText(child);
      out += "\n"; // block boundary (paragraph, heading, list item, …)
    }
  });
  return out;
}

export function decodeDocText(snapshot: Buffer | Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(snapshot));
    return fragmentText(doc.getXmlFragment("default"))
      .replace(/\n{2,}/g, "\n")
      .trim();
  } finally {
    doc.destroy();
  }
}

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

// Minimal LCS line diff (good enough for a version-compare view). O(n*m) on
// line counts — fine for document-sized inputs.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}
