import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";

const API = "http://localhost:3000/api/trpc";
const COLLAB = "ws://localhost:1234";
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

function connect(docId, token, user) {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: COLLAB, name: docId, token, document: doc, WebSocketPolyfill: WebSocket,
  });
  // Simulate what CollaborationCursor publishes into Yjs awareness.
  provider.setAwarenessField("user", user);
  return { doc, provider };
}
const waitSynced = (p) =>
  new Promise((res, rej) => {
    if (p.synced) return res();
    const t = setTimeout(() => rej(new Error("sync timeout")), 10000);
    p.on("synced", () => { clearTimeout(t); res(); });
  });

let fail = false;
const assert = (c, m) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail = true; };

function peersOf(provider) {
  const aw = provider.awareness;
  const list = [];
  for (const [cid, st] of aw.getStates()) {
    if (st.user?.name) list.push({ cid, name: st.user.name, color: st.user.color, isSelf: cid === aw.clientID });
  }
  return list;
}

const email = `m2_${Date.now()}@example.com`;
const signup = await mutate("auth.signup", { email, password: "password123", displayName: "Owner" });
const token = signup.accessToken;
const doc = await mutate("documents.create", { title: "Presence Doc" }, token);
const docId = doc.id;
console.log("setup: doc", docId.slice(0, 8));

const alice = { name: "Alice Liddell", color: "#ec4899" };
const bob = { name: "Bob Stone", color: "#10b981" };

console.log("\n[awareness presence]");
const A = connect(docId, token, alice);
const B = connect(docId, token, bob);
await Promise.all([waitSynced(A.provider), waitSynced(B.provider)]);
await sleep(900); // let awareness propagate

const aPeers = peersOf(A.provider);
const bPeers = peersOf(B.provider);

assert(aPeers.length === 2, `A sees 2 collaborators (got ${aPeers.length})`);
assert(bPeers.length === 2, `B sees 2 collaborators (got ${bPeers.length})`);

const aSelf = aPeers.find((p) => p.isSelf);
const aOther = aPeers.find((p) => !p.isSelf);
assert(aSelf?.name === "Alice Liddell" && aSelf?.color === alice.color, "A identifies self as Alice with correct color");
assert(aOther?.name === "Bob Stone" && aOther?.color === bob.color, "A sees Bob with real name + color");

const bSelf = bPeers.find((p) => p.isSelf);
const bOther = bPeers.find((p) => !p.isSelf);
assert(bSelf?.name === "Bob Stone", "B identifies self as Bob");
assert(bOther?.name === "Alice Liddell", "B sees Alice");

// Disconnect A -> B should drop to just itself (presence reflects real connections)
console.log("\n[presence updates on leave]");
A.provider.destroy(); A.doc.destroy();
await sleep(900);
const bAfter = peersOf(B.provider);
assert(bAfter.length === 1 && bAfter[0].isSelf, `B sees only itself after A leaves (got ${bAfter.length})`);

B.provider.destroy(); B.doc.destroy();
console.log(`\n${fail ? "M2 DoD: FAIL ❌" : "M2 DoD: PASS ✅"}`);
process.exit(fail ? 1 : 0);
