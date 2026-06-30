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
const errOf = (o) => o?.error?.json ?? o?.[0]?.error?.json;

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
  const body = await r.json();
  return { status: r.status, data: dataOf(body), error: errOf(body) };
}
const signup = (email, name) => call("POST", "auth.signup", { email, password: "password123", displayName: name });
const login = (email) => call("POST", "auth.login", { email, password: "password123" });
const myAccess = (docId, token) => call("GET", "documents.myAccess", { id: docId }, token);

let fail = false;
const assert = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail = true; };

const pg = new Client({ connectionString: DB });
await pg.connect();

// userA owns orgA; create a doc A owns.
const a = await signup(`m3a_${Date.now()}@ex.com`, "Owner A");
const tokenA = a.data.accessToken;
const orgId = a.data.user.orgId;
const userAId = a.data.user.id;
const doc = (await call("POST", "documents.create", { title: "RBAC Doc" }, tokenA)).data;
const docId = doc.id;

// userB: second member of the SAME org (no join flow yet → insert directly).
const emailB = `m3b_${Date.now()}@ex.com`;
const hashB = bcrypt.hashSync("password123", 10);
const userBId = (await pg.query(
  "insert into users (org_id,email,display_name,avatar_color,password_hash) values ($1,$2,'Member B','#10b981',$3) returning id",
  [orgId, emailB, hashB],
)).rows[0].id;
const tokenB = (await login(emailB)).data.accessToken;
console.log(`setup: org ${orgId.slice(0,8)} doc ${docId.slice(0,8)} A=${userAId.slice(0,8)} B=${userBId.slice(0,8)}`);

console.log("\n[matrix: creator owns]");
let ma = await myAccess(docId, tokenA);
// create grants the creator owner at DOCUMENT scope (most-specific).
assert(ma.data.role === "owner" && ma.data.viaScope?.type === "document", "A (creator) resolves owner via DOCUMENT scope");
assert(ma.data.canEdit && ma.data.canShare && ma.data.canTransferOwnership, "owner can edit/share/transfer");

// Org-scope inheritance: a doc B creates is reachable by org-owner A via ORG.
const docB = (await call("POST", "documents.create", { title: "B's doc" }, tokenB)).data;
const maInherit = await myAccess(docB.id, tokenA);
assert(maInherit.data.role === "owner" && maInherit.data.viaScope?.type === "organization", "A reaches B's doc as owner via ORG inheritance");

console.log("\n[no access before share]");
const mb0 = await myAccess(docId, tokenB);
assert(mb0.data.role === null && mb0.data.canView === false, "B has no role before sharing");
const getB0 = await call("GET", "documents.get", { id: docId }, tokenB);
assert(getB0.status === 404 || getB0.error?.code === "NOT_FOUND", "B get() denied (NOT_FOUND, no existence leak)");

console.log("\n[share grants real access]");
await call("POST", "assignments.grant", { docId, email: emailB, roleName: "viewer" }, tokenA);
let mb = await myAccess(docId, tokenB);
assert(mb.data.role === "viewer" && mb.data.viaScope?.type === "document", "B is viewer via DOCUMENT scope after share");
assert(mb.data.canView === true && mb.data.canEdit === false, "viewer can view but NOT edit");

await call("POST", "assignments.grant", { docId, email: emailB, roleName: "editor" }, tokenA);
mb = await myAccess(docId, tokenB);
assert(mb.data.role === "editor" && mb.data.canEdit === true && mb.data.canShare === false, "re-share to editor: can edit, cannot share");

console.log("\n[most-specific scope wins]");
// Give A a document-scope viewer assignment; it must override A's org owner.
await pg.query(
  `insert into assignments (org_id,user_id,role_id,scope_type,scope_id)
   select $1,$2,r.id,'document',$3 from roles r where r.org_id=$1 and r.name='viewer'
   on conflict (user_id,scope_type,scope_id) do update set role_id=excluded.role_id`,
  [orgId, userAId, docId],
);
ma = await myAccess(docId, tokenA);
assert(ma.data.role === "viewer" && ma.data.viaScope?.type === "document", "A now viewer via DOCUMENT scope (doc overrides org)");
// Restore A to document owner for the transfer test.
await pg.query(
  `update assignments set role_id=(select id from roles where org_id=$1 and name='owner')
   where user_id=$2 and scope_type='document' and scope_id=$3`,
  [orgId, userAId, docId],
);

console.log("\n[cross-org denial]");
const c = await signup(`m3c_${Date.now()}@ex.com`, "Outsider C");
const mc = await myAccess(docId, c.data.accessToken);
assert(mc.data.role === null && mc.data.canView === false, "user from another org sees no access (no cross-org)");
const getC = await call("GET", "documents.get", { id: docId }, c.data.accessToken);
assert(getC.status === 404 || getC.error?.code === "NOT_FOUND", "cross-org get() denied");

console.log("\n[viewer cannot grant (server-enforced 403)]");
const badShare = await call("POST", "assignments.grant", { docId, email: "x@ex.com", roleName: "viewer" }, tokenB);
assert(badShare.status === 403, "editor B cannot share (server 403)");

console.log("\n[atomic ownership transfer]");
const tr = await call("POST", "assignments.transferOwnership", { docId, email: emailB }, tokenA);
assert(tr.data?.ok === true, "transfer succeeds");
const maT = await myAccess(docId, tokenA);
const mbT = await myAccess(docId, tokenB);
assert(mbT.data.role === "owner", "B is now owner");
assert(maT.data.role === "editor" && maT.data.viaScope?.type === "document", "A demoted to editor (doc scope)");

console.log("\n[live: viewer cannot edit via collab (real boundary)]");
const doc2 = (await call("POST", "documents.create", { title: "ReadOnly Test" }, tokenA)).data;
await call("POST", "assignments.grant", { docId: doc2.id, email: emailB, roleName: "viewer" }, tokenA);
// Owner seeds content.
const yA = new Y.Doc();
const pA = new HocuspocusProvider({ url: COLLAB, name: doc2.id, token: tokenA, document: yA, WebSocketPolyfill: WebSocket });
await new Promise((res) => (pA.synced ? res() : pA.on("synced", res)));
yA.getText("content").insert(0, "owner text");
await sleep(700);
// Viewer connects (server should mark read-only) and tries to write.
const yB = new Y.Doc();
const pB = new HocuspocusProvider({ url: COLLAB, name: doc2.id, token: tokenB, document: yB, WebSocketPolyfill: WebSocket });
await new Promise((res) => (pB.synced ? res() : pB.on("synced", res)));
yB.getText("content").insert(0, "VIEWER HACK ");
await sleep(900);
pA.destroy(); yA.destroy(); pB.destroy(); yB.destroy();
await sleep(2500); // persist
// Fresh client reads the persisted truth.
const yC = new Y.Doc();
const pC = new HocuspocusProvider({ url: COLLAB, name: doc2.id, token: tokenA, document: yC, WebSocketPolyfill: WebSocket });
await new Promise((res) => (pC.synced ? res() : pC.on("synced", res)));
await sleep(400);
const persisted = yC.getText("content").toString();
pC.destroy(); yC.destroy();
assert(!persisted.includes("VIEWER HACK"), `viewer's write rejected by server (persisted: "${persisted}")`);
assert(persisted.includes("owner text"), "owner's write persisted");

await pg.end();
console.log(`\n${fail ? "M3 DoD: FAIL ❌" : "M3 DoD: PASS ✅"}`);
process.exit(fail ? 1 : 0);
