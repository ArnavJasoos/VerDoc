import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require(
  require.resolve("pg", { paths: ["../../packages/db"] }),
);

const API = "http://localhost:3000/api/trpc";
const COLLAB = "ws://localhost:1234";
const DB = "postgresql://postgres:root@127.0.0.1:5432/verdoc";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => o?.result?.data?.json;

async function mutate(path, input, token) {
  const r = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ json: input }),
  });
  return out(await r.json());
}

function connect(docId, token) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: COLLAB,
    name: docId,
    token,
    document: doc,
    WebSocketPolyfill: WebSocket,
    onAuthenticationFailed: ({ reason }) => console.log("  AUTH FAIL:", reason),
  });
  return { doc, provider };
}

const waitSynced = (provider) =>
  new Promise((res, rej) => {
    if (provider.synced) return res();
    const t = setTimeout(() => rej(new Error("sync timeout")), 10000);
    provider.on("synced", () => { clearTimeout(t); res(); });
  });

let fail = false;
const assert = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail = true; };

// 1) Real user + doc via the API (no mocks)
const email = `m1_${Date.now()}@example.com`;
const signup = await mutate("auth.signup", { email, password: "password123", displayName: "M1 Tester" });
const token = signup.accessToken;
const userId = signup.user.id;
const doc = await mutate("documents.create", { title: "Collab Doc" }, token);
const docId = doc.id;
console.log("setup: user", userId.slice(0, 8), "doc", docId.slice(0, 8));

// 2) Two clients converge
console.log("\n[convergence]");
const A = connect(docId, token);
const B = connect(docId, token);
await Promise.all([waitSynced(A.provider), waitSynced(B.provider)]);
A.doc.getText("content").insert(0, "Hello from A");
await sleep(800);
assert(B.doc.getText("content").toString() === "Hello from A", "B sees A's edit");
B.doc.getText("content").insert(12, " + B");
await sleep(800);
assert(A.doc.getText("content").toString() === "Hello from A + B", "A sees B's edit (converged)");
const finalText = A.doc.getText("content").toString();

// 3) Disconnect -> server persists -> fresh client restores from Yjs blob
console.log("\n[persistence / reload]");
A.provider.destroy(); B.provider.destroy(); A.doc.destroy(); B.doc.destroy();
await sleep(3500); // allow onStoreDocument (debounce + disconnect)

const C = connect(docId, token);
await waitSynced(C.provider);
await sleep(400);
assert(C.doc.getText("content").toString() === finalText, `reload restores content ("${C.doc.getText("content").toString()}")`);
C.provider.destroy(); C.doc.destroy();

// 4) Metadata refresh + blob persisted (plan §2.5)
console.log("\n[metadata + blob]");
const pg = new Client({ connectionString: DB });
await pg.connect();
const meta = (await pg.query("select last_editor_id, updated_at, created_at from documents where id=$1", [docId])).rows[0];
const blob = (await pg.query("select octet_length(state) len from ydoc_state where document_id=$1", [docId])).rows[0];
await pg.end();
assert(meta.last_editor_id === userId, "documents.last_editor_id stamped by collab server");
assert(new Date(meta.updated_at) > new Date(meta.created_at), "documents.updated_at advanced past created_at");
assert(blob && blob.len > 0, `ydoc_state blob persisted (${blob?.len} bytes)`);

console.log(`\n${fail ? "M1 DoD: FAIL ❌" : "M1 DoD: PASS ✅"}`);
process.exit(fail ? 1 : 0);
