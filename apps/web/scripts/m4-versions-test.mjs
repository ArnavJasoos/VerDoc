import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require(require.resolve("pg", { paths: ["../../packages/db"] }));
const bcrypt = require(require.resolve("bcryptjs", { paths: ["."] }));

const API = "http://localhost:3000/api/trpc";
const COLLAB = "ws://localhost:1234";
const DB = "postgresql://postgres:root@127.0.0.1:5432/verdoc";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataOf = (o) => o?.result?.data?.json;

async function call(method, path, input, token) {
  const isQuery = method === "GET";
  const url = isQuery
    ? `${API}/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
    : `${API}/${path}`;
  const r = await fetch(url, {
    method: isQuery ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(isQuery ? {} : { body: JSON.stringify({ json: input }) }),
  });
  return { status: r.status, data: dataOf(await r.json()) };
}
const signup = (email, name) => call("POST", "auth.signup", { email, password: "password123", displayName: name });
const login = (email) => call("POST", "auth.login", { email, password: "password123" });

let fail = false;
const assert = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail = true; };

// Write a paragraph into the doc's Yjs "default" fragment and wait for the
// collab server to persist (onStoreDocument).
async function writeParagraph(docId, token, text) {
  const ydoc = new Y.Doc();
  const p = new HocuspocusProvider({ url: COLLAB, name: docId, token, document: ydoc, WebSocketPolyfill: WebSocket });
  await new Promise((res) => (p.synced ? res() : p.on("synced", res)));
  const frag = ydoc.getXmlFragment("default");
  const el = new Y.XmlElement("paragraph");
  el.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [el]);
  await sleep(2600); // Hocuspocus store debounce
  p.destroy(); ydoc.destroy();
  await sleep(400);
}

const pg = new Client({ connectionString: DB });
await pg.connect();

const a = await signup(`m4a_${Date.now()}@ex.com`, "Manager A");
const tokenA = a.data.accessToken;
const orgId = a.data.user.orgId;
const userAId = a.data.user.id;

const emailB = `m4b_${Date.now()}@ex.com`;
const userBId = (await pg.query(
  "insert into users (org_id,email,display_name,avatar_color,password_hash) values ($1,$2,'Collab B','#3b82f6',$3) returning id",
  [orgId, emailB, bcrypt.hashSync("password123", 10)],
)).rows[0].id;
const tokenB = (await login(emailB)).data.accessToken;

const doc = (await call("POST", "documents.create", { title: "Spec" }, tokenA)).data;
const docId = doc.id;
// Share as editor: B can submit + view history, but cannot approve.
await call("POST", "assignments.grant", { docId, email: emailB, roleName: "editor" }, tokenA);
console.log(`setup: doc ${docId.slice(0,8)} A=manager B=editor`);

console.log("\n[submit transitions working -> pending_approval + notifies approver]");
await writeParagraph(docId, tokenB, "version one");
const sub = await call("POST", "versions.submit", { docId }, tokenB);
assert(sub.data?.status === "pending_approval", "submit returns pending_approval");
const docAfterSubmit = await call("GET", "documents.get", { id: docId }, tokenA);
assert(docAfterSubmit.data?.status === "pending_approval", "doc status is pending_approval");
const aNotifs = await call("GET", "notifications.list", undefined, tokenA);
assert(aNotifs.data?.some((n) => n.type === "submitted"), "approver A notified of submission");

console.log("\n[editor cannot approve (403); trash blocked while pending]");
const bApprove = await call("POST", "versions.approve", { docId }, tokenB);
assert(bApprove.status === 403, "editor B cannot approve (403)");
const trashPending = await call("POST", "documents.trash", { id: docId }, tokenA);
assert(trashPending.status === 400, "cannot trash while pending approval (400)");

console.log("\n[reject -> working + recommendation + notifies submitter]");
const rej = await call("POST", "versions.reject", { docId, recommendation: "Add more detail" }, tokenA);
assert(rej.data?.status === "working", "reject returns working");
const bNotifs = await call("GET", "notifications.list", undefined, tokenB);
assert(bNotifs.data?.some((n) => n.type === "rejected"), "submitter B notified of rejection");

console.log("\n[resubmit + approve -> approved + notifies submitter]");
await writeParagraph(docId, tokenB, "version two added");
await call("POST", "versions.submit", { docId }, tokenB);
const appr = await call("POST", "versions.approve", { docId }, tokenA);
assert(appr.data?.status === "approved", "approve returns approved");
const docFinal = await call("GET", "documents.get", { id: docId }, tokenA);
assert(docFinal.data?.status === "approved", "doc status is approved");
const bNotifs2 = await call("GET", "notifications.list", undefined, tokenB);
assert(bNotifs2.data?.some((n) => n.type === "approved"), "submitter B notified of approval");

console.log("\n[history + two-snapshot diff]");
const hist = await call("GET", "versions.history", { docId }, tokenA);
const vers = hist.data ?? [];
assert(vers.length >= 3, `history has the snapshots (got ${vers.length})`);
assert(vers.some((v) => v.kind === "approved") && vers.some((v) => v.kind === "submission"), "history has submission + approved kinds");
// Compare the earliest submission to the latest (approved) version.
const sorted = [...vers].sort((x, y) => x.versionNo - y.versionNo);
const first = sorted[0], last = sorted[sorted.length - 1];
const diff = await call("GET", "versions.diff", { docId, beforeVersionId: first.id, afterVersionId: last.id }, tokenA);
const added = (diff.data ?? []).filter((l) => l.type === "add").map((l) => l.text);
assert(added.some((t) => t.includes("version two")), `diff shows the added line (added: ${JSON.stringify(added)})`);

console.log("\n[approved doc can now be trashed by owner]");
const trashOk = await call("POST", "documents.trash", { id: docId }, tokenA);
assert(trashOk.data?.ok === true, "owner can trash an approved (non-pending) doc");

await pg.end();
console.log(`\n${fail ? "M4 DoD: FAIL ❌" : "M4 DoD: PASS ✅"}`);
process.exit(fail ? 1 : 0);
