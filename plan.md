# VerDoc — Architecture & Build Game Plan

A from-scratch rebuild of the Docolab collaborative document platform: real-time
multi-user editing, document versioning with review/approval, role-based access,
comments/suggestions, and AI assistance.

This document is the **complete game plan** — no code. It is written so a fresh
Claude Code session (and your team) can build the project smoothly, in order,
without the system-design dead-ends that stalled the previous attempt.

---

## 0. Why the last attempt stalled (root causes to design out)

Be explicit about the failure modes so the new architecture *structurally
prevents* them, not just "tries harder":

1. **Two sources of truth for document content.** Content lived in a
   localStorage/REST record *and* was supposed to be Yjs-canonical. They were
   never reconciled — the REST layer returned blank content, edits didn't
   persist offline, and "status" was a cosmetic field. **This is the #1 thing to
   fix.**
2. **A half-migrated API layer.** Some modules hit the real backend, others were
   localStorage stubs, others were MSW mocks — three parallel "backends" at
   runtime. Nobody could tell what was real.
3. **Frontend/backend type drift.** Hand-written TS types mirrored Python
   schemas by copy-paste; they silently diverged (e.g. the document list item
   was missing `updated_at`, so the UI showed "recently" everywhere).
4. **No single authorization gate.** Permissions were re-derived ad hoc; the UI
   had role logic the store never actually provided.
5. **Features half-wired.** Approval actions existed but weren't mounted;
   presence/sharing had no clean backend mapping.

**Design principles that follow directly:**

- **One writer per piece of state.** Live content has exactly one owner: the Yjs
  document. Everything else is a *derived read-model*.
- **Type-safe by construction, not by discipline.** The API contract is
  generated/shared, never hand-mirrored.
- **One runtime backend in every environment.** No stub-as-runtime. Mocks are
  for tests only.
- **Server is the only security gate.** A single `authorize()` everywhere.
- **Vertical slices over horizontal layers.** Ship one real end-to-end feature
  at a time (walking skeleton first), never "all the models, then all the
  routes, then all the UI."

---

## 1. Recommended stack (with the reasoning)

Your team's pain was **system design + coordination**, not raw coding. So the
stack is chosen to *minimize moving parts and eliminate whole classes of bugs*.

### Option A — All-TypeScript, type-safe end-to-end (RECOMMENDED)

| Layer | Choice | Why |
|-------|--------|-----|
| Monorepo | pnpm workspaces + Turborepo | One repo, shared packages, one install, coordinated builds |
| Language | TypeScript everywhere | One language across web + API + collab server → shared types, no context-switching |
| Frontend | Next.js (App Router) + React | Same as before; mature |
| Editor | **Tiptap** (ProseMirror) | First-party Comments, Suggestions, Snapshots, and Hocuspocus — one vendor, best docs. Removes the hardest integration work for an inexperienced team |
| API | **tRPC** (or Hono + OpenAPI) | tRPC gives end-to-end types with **zero codegen and zero drift by construction** — the single biggest fix for failure #3 |
| DB | PostgreSQL + **Drizzle ORM** | Typed queries + first-class migrations; schema is TS, shared with the app |
| Realtime/collab | **Hocuspocus** (self-host) | Reference Yjs backend; you own persistence + auth |
| Auth | **Clerk** (managed) or Lucia (self-host) | Managed auth removes an entire hard subsystem; see §7 |
| AI | Vercel AI SDK + provider (Gemini/Claude) | Streaming, tool-calls, provider-swappable |

**Headline win:** with tRPC + a shared Drizzle schema + shared types, the
frontend literally cannot call an endpoint that doesn't exist or pass the wrong
shape — the compiler stops it. Failure #3 becomes impossible.

### Option B — Polyglot, closest to your current code

| Layer | Choice | Notes |
|-------|--------|-------|
| Frontend | Next.js + **Plate.js** | Reuse existing editor knowledge |
| API | **FastAPI** + Pydantic + SQLAlchemy async | Reuse existing Python work |
| Contract | **OpenAPI → generated TS client** (Hey API / openapi-typescript) | MUST be generated, never hand-written; regenerate on every backend change |
| Collab | Hocuspocus | Same as A |
| Auth | self-hosted JWT (as today) | See §7 for the secure pattern |

Choose B only if reusing the partial backend + Python familiarity outweighs the
coordination cost. **For the smoothest from-scratch build, pick A.** The rest of
this plan is written stack-agnostically where possible and calls out specifics.

### De-risking dial (managed vs self-hosted)

The two hardest subsystems for an inexperienced team are **realtime collab** and
**auth**. You can buy your way out of either:

- **Collab:** Tiptap Cloud / Liveblocks (managed) → migrate to self-hosted
  Hocuspocus later once the product is proven. Self-hosted Hocuspocus at ~1k MAU
  is ~$20–40/mo but carries real ops burden (sticky sessions, Redis, uptime).
- **Auth:** Clerk/Auth0 (managed) → removes refresh-rotation, reuse-detection,
  password reset, email flows entirely.

**Recommendation for v1:** managed auth (Clerk) + self-hosted Hocuspocus. Auth is
"solved" cheaply; collab is your core IP so own it, but keep the option to start
on managed collab if the team wants to validate UX first.

---

## 2. The crux: content, collaboration & versioning model

This single section is the difference between success and the last attempt.
**Read it twice.**

### 2.1 One writer for live content

- The **Yjs document is the sole source of truth for document body content.**
- The collab server (Hocuspocus) persists the Yjs state as a **binary blob**
  (`ydoc_state BYTEA`) via its `onLoadDocument` / `onStoreDocument` hooks.
- The **relational `documents` row never stores the body.** It stores metadata
  only (title, status, owner, version pointer, timestamps, flags).
- The room id = the document's stable id (a UUID). One URL → one room.

### 2.2 Derived read-models (how everything non-editor reads content)

Surfaces that are *not* the live editor (list cards, search, export, AI,
email/notifications) must never invent their own content store. They read a
**derived** representation produced from the Yjs doc:

- The collab server exposes (or a small worker computes) a **serialization**
  (JSON / HTML / Markdown / plain-text) whenever the doc is stored.
- Store that derived text on the `documents` row (e.g. `excerpt`, `plain_text`
  for search) or in a search index. It is **read-only and regenerated**, never
  edited directly.

### 2.3 Versioning = event sourcing (ops log → snapshots)

This is the industry pattern (Yjs/Tiptap support it natively):

- Every edit is a Yjs update (the implicit op log).
- A **version/snapshot** is the materialized Yjs state at a point in time, stored
  as an immutable row.
- **Restore** = load the snapshot's state into the room (or open it read-only /
  as a branch). **Diff/compare** = decode two snapshots and compare.

`versions` row (immutable, append-only):
`id, document_id, version_no, kind (submission|approved|autosave), ydoc_snapshot BYTEA, created_by, created_at, meta JSONB`.

### 2.4 Approval workflow as state transitions (never a free-text field)

`documents.status` is owned exclusively by the versioning service and changes
only through these transitions:

```
working ──submit-for-approval──▶ pending_approval ──approve──▶ approved
   ▲                                   │
   └────────────── reject ─────────────┘
```

- **submit-for-approval:** snapshot(kind=submission) + status→pending_approval.
- **approve:** snapshot(kind=approved) + status→approved (or back to working for
  continued editing, per your policy) + notify submitter.
- **reject:** status→working + attach reviewer feedback (a recommendation/
  comment) + notify.
- Guard rails: cannot trash/delete a doc while `pending_approval`.

### 2.5 Metadata freshness (fixes "updated_at" gap)

The collab server's `onStoreDocument` hook updates `documents.updated_at` and
`last_editor_id`. So lists/cards always show accurate "edited 2h ago by X" —
something the old build couldn't because the list item lacked the field.

### 2.6 Offline / fallback policy (be explicit, never silent)

This is a "stays-online" product (Google-Docs-like). Decide and document:

- **Online is the only persisted path.** If the collab server is unreachable, the
  editor opens **read-only** with a clear banner ("Reconnecting… changes are
  paused"), NOT a silently-non-persisting editable doc (the old trap).
- Yjs offline edits (IndexedDB) can be enabled later for true offline; treat as a
  v2 feature with explicit conflict UX.

---

## 3. Data model (relational)

Postgres. All tables (except global lookups) carry `org_id` for tenant
isolation. Content bodies live in Yjs, not here.

**Identity & tenancy**
- `organizations` — id, name, created_at
- `users` — id, org_id, email (unique per org), display_name, avatar_color,
  status, created_at  *(omit password_hash if using managed auth)*
- `memberships` — user_id, org_id, org_role (admin|member)  *(if multi-org)*

**Documents & structure**
- `folders` — id, org_id, parent_folder_id (nullable), name, created_by
- `documents` — id, org_id, folder_id (nullable), title, status
  (working|pending_approval|approved|trashed→via flag|deleted), current_version_no,
  ydoc_room_key, created_by, last_editor_id, created_at, updated_at,
  trashed (bool), trashed_at, plain_text (derived, for search)
- `ydoc_state` — document_id (pk), state BYTEA, updated_at  *(written by collab
  server; could also be a column on documents)*
- `document_stars` — user_id, document_id, org_id  *(personal bookmarks; unique
  per pair)*

**Versioning & approval**
- `versions` — id, document_id, version_no, kind, ydoc_snapshot BYTEA,
  created_by, created_at, meta JSONB
- `approval_policies` — id, org_id, name, rules JSONB  *(optional; who must
  approve)*
- `recommendations` — id, version_id, author_id, body, created_at  *(reviewer
  feedback on a submission)*

**Comments & suggestions**
- `comments` — id, document_id, thread_root_id (nullable for replies), author_id,
  body, anchor JSONB (selection range), is_resolved, suggestion_id (nullable),
  created_at
- `suggestions` — id, document_id, author_id, kind (insert|delete|replace),
  payload JSONB, status (open|accepted|rejected), created_at
  *(if using Tiptap, its Comments/Suggestions extensions manage much of this; you
  still mirror resolved/threaded state for queries + notifications)*

**Access control** (see §6)
- `roles` — id, org_id, name (owner|approver|editor|viewer), description
- `permissions` — id, key (can_edit, can_comment, can_submit, can_approve,
  can_manage_members, can_view_history, …)
- `role_permissions` — role_id, permission_id
- `assignments` — id, org_id, user_id, role_id, scope_type
  (organization|folder|document), scope_id  *(unique on user+scope)*

**Activity**
- `notifications` — id, user_id, document_id, type, payload JSONB, read_at,
  created_at
- `audit_log` — id, org_id, actor_id, action, target_type, target_id,
  document_id, meta JSONB, created_at

---

## 4. System architecture (services & flow)

```
                         ┌─────────────────────────────┐
                         │        Next.js (web)         │
                         │  React + Tiptap editor       │
                         └───────┬──────────────┬───────┘
            type-safe API calls  │              │  WebSocket (Yjs)
                 (tRPC/OpenAPI)   │              │
                         ┌────────▼───────┐  ┌───▼──────────────────┐
                         │   API service  │  │  Hocuspocus (collab) │
                         │ tRPC / FastAPI │  │  Yjs sync + presence │
                         │  authZ, CRUD,  │  │  onAuth (JWT),       │
                         │  versions,     │  │  onStoreDocument →   │
                         │  comments,RBAC │  │   persist + metadata │
                         └───────┬────────┘  └───┬──────────────┬───┘
                                 │               │              │
                         ┌───────▼───────────────▼───┐   ┌──────▼──────┐
                         │        PostgreSQL          │   │   Redis     │
                         │ metadata, RBAC, versions,  │   │ pub/sub for │
                         │ comments, ydoc_state blob  │   │ collab scale│
                         └────────────────────────────┘   └─────────────┘
```

- **API service** owns all relational reads/writes + authorization. It does
  **not** touch live content.
- **Hocuspocus** owns live content + presence. On connect it validates the same
  JWT/session the API uses; on store it persists the Yjs blob and pings the API
  (or writes directly) to refresh `documents.updated_at`/`last_editor_id`.
- **Redis** only needed when you run >1 collab instance (pub/sub + sticky
  sessions). Single instance for v1 is fine.
- **Shared secret/JWT** so the collab server trusts the same identity as the API.

---

## 5. Authentication

Pick one; both end at "server is the only gate."

### 5.1 Recommended: managed (Clerk/Auth0)
- Frontend uses the provider's SDK; backend verifies the provider JWT (JWKS).
- Hocuspocus `onAuthenticate` verifies the same token.
- You skip password storage, refresh rotation, reuse-detection, reset emails.

### 5.2 Self-hosted (if you must own it) — the 2026 secure pattern
- **Access token in memory** (JS variable), short-lived (5–15 min).
- **Refresh token in an HttpOnly, Secure, SameSite cookie**, scoped to
  `/auth/refresh`, long-lived (7–30 days), opaque, stored server-side.
- **Rotation + reuse detection:** each refresh issues a new pair and invalidates
  the old; a reused refresh token revokes the whole family.
- **Never** localStorage for tokens (the old build's XSS exposure).
- Optional hardening: Backend-for-Frontend (BFF) so the browser holds only a
  session cookie and tokens never reach JS.

Either way: **a client-side route guard is UX only** (redirect to /login when no
session); the real boundary is server-side checks on every call.

---

## 6. Authorization (RBAC)

One model, one function, used everywhere. Mirrors your current UI→backend role
mapping but makes resolution explicit.

**Roles → permissions** (seeded per org):

| UI role | Backend role | Core permissions |
|---------|--------------|------------------|
| Owner | owner | everything incl. can_manage_members, can_manage_policy, delete |
| Manager | approver | edit, comment, submit, **approve/reject**, view_history |
| Collaborator | editor | edit, comment, submit, view_history |
| Viewer | viewer | view, view_history (read-only) |

**Scope hierarchy with inheritance:** `organization → folder → document`. A
user's effective role on a document = the most specific assignment found walking
**document → its folder(s) → org**. One assignment table, `scope_type` +
`scope_id`.

**The single gate:** `authorize(userId, permission, scopeType, scopeId) →
{allowed, resolvedRole, viaScope}`.
- Every mutating API call calls it and 403s on failure.
- The collab server calls it on connect (read = can_view; write = can_edit).
- The frontend calls a read-only `my-access` endpoint to decide which controls
  to render — **display logic only**.

**Rules that prevent the classic failures:**
- No cross-org reads/writes — `org_id` filter on every query.
- Permission checks are centralized and unit-tested (table-driven).
- "Creator owns": creating a doc/folder grants the creator `owner` at that scope.
- Ownership transfer is atomic (grant new owner, then demote self).

---

## 7. API design (modules)

Contract-first regardless of stack. With tRPC the "contract" is the router types;
with FastAPI it's the generated OpenAPI client. **One module per domain**, thin
HTTP layer over a service layer.

| Module | Responsibilities |
|--------|------------------|
| auth | login/signup/refresh/logout/me (or managed-provider glue) |
| users | org roster, profile read/update |
| documents | CRUD, trash/restore, star, list (filters: all/recent/starred/shared/trash), my-access |
| folders | CRUD, move, list |
| versions | list, get, submit-for-approval, approve, reject, restore, diff |
| comments | list/create/resolve (threaded, anchored) |
| suggestions | list/create/accept/reject |
| assignments+roles | list roles, list/grant/revoke assignments, transfer ownership |
| notifications | list, mark-read, mark-all-read |
| ai | suggest/apply jobs (async), job status |
| export | document/version → md/html/pdf (from derived serialization) |
| audit | document + org activity feed |

**Service layer** holds business logic (e.g. `versionsService.submit()` does
snapshot + status transition + notify in one transaction). HTTP handlers stay
thin. This is what was missing — logic was scattered into UI and stubs.

---

## 8. Frontend architecture

```
apps/web/
  app/                     # Next.js App Router
    (auth)/login, signup
    (app)/browser          # document list (filters via search params)
    (app)/editor/[docId]   # the editor
    layout, providers
  components/
    editor/                # Tiptap setup, toolbar, comments panel, presence,
                           # version history, share dialog, approval actions
    browser/               # doc cards, sidebar, filters
    ui/                    # design-system primitives (shadcn-style)
  lib/
    api/                   # the ONE generated/tRPC client — no hand types
    collab/                # Hocuspocus provider + Yjs wiring
    auth/                  # session hook + route guard
    rbac/                  # caps-from-role helper (display only)
  hooks/
```

**State rules (avoid the old mess):**
- **Server data** → the typed API client + a cache (TanStack Query, or tRPC's
  built-in). No bespoke stores duplicating server state.
- **Live document content** → Yjs/Tiptap only. Never mirror it into React state
  or a metadata store.
- **Local UI state** → component state/context.
- **The session user** → one `useSession()` source; every "who am I" surface
  (nav avatar, comment author, presence, "(you)" tags) reads from it. (The old
  build hardcoded a seed user — design this as one hook from day one.)

**Routing/guard:** protected routes wrapped by a client guard that checks session
and redirects; SSR-safe (no hydration mismatch).

---

## 9. Realtime: presence, comments, suggestions

- **Presence/cursors:** Yjs **awareness** (name + color from the session user).
  This is the correct source — not a polled REST endpoint (the old build's stub).
- **Comments:** anchored to document ranges; threaded; resolve/unresolve. With
  Tiptap, use the Comments extension and mirror thread state to the `comments`
  table for queries + notifications. Author identity = session user; the roster
  is loaded so *everyone's* name resolves (the old build only knew the current
  user → blank names).
- **Suggestions / track-changes:** Tiptap Suggestions (or ProseMirror change
  tracking). Accept/reject writes through to the API and the Yjs doc.
- **AI attribution:** mark AI-authored ranges with a metadata mark so they're
  visibly distinguishable and reviewable, same channel as suggestions.

---

## 10. AI features

- Server-side AI routes (Vercel AI SDK), provider behind an interface so you can
  swap Gemini/Claude. Use the latest models; keep keys server-side only.
- Patterns: inline "command" (rewrite/expand/summarize selection), copilot
  autocomplete, and "review this submission" assist for approvers.
- Long operations run as **async jobs** (enqueue → poll status), so the UI never
  blocks. AI edits enter as **suggestions**, not silent overwrites.

---

## 11. Monorepo layout

```
verdoc/
  apps/
    web/                # Next.js
    api/                # tRPC/Hono service (or FastAPI in Option B)
    collab/             # Hocuspocus server
  packages/
    db/                 # Drizzle schema + migrations (shared)
    types/              # shared domain types / tRPC router types
    auth/               # session/JWT helpers shared by api + collab
    config/             # eslint, tsconfig, tailwind presets
    ui/                 # shared components (optional)
  docker-compose.yml    # postgres + redis + (optional) all services
  turbo.json, pnpm-workspace.yaml
```

In Option B the `api/` app is Python (separate tooling) and `packages/types` is
**generated** from its OpenAPI schema.

---

## 12. Environments & configuration

- **Single source for env:** a typed env loader (e.g. `@t3-oss/env`) that fails
  fast on missing/invalid vars. No more "defaults to localhost if unset" guessing.
- **One docker-compose** brings up Postgres + Redis (+ services) so any dev — and
  Claude Code — runs the *real* backend locally. No stub mode.
- Shared secret: API `JWT_SECRET`/JWKS == collab server's, so identity is unified.
- Keys: `DATABASE_URL`, `REDIS_URL`, auth provider keys, `AI_API_KEY`,
  `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_COLLAB_URL`.

---

## 13. Build order — the milestone plan

Build in **vertical slices**. Each milestone is shippable and demoable. Do **not**
proceed until the slice's "Definition of Done" passes. This sequencing is the
antidote to the previous "everything half-built" state.

**M0 — Walking skeleton (1 slice end-to-end)**
- Monorepo, docker-compose (Postgres), typed env, CI (lint+typecheck+build).
- DB: `organizations`, `users`. Auth (managed or minimal real).
- One real flow: **log in → see an empty document list → create a blank doc →
  open it (local Tiptap, no collab yet) → it appears in the list.**
- DoD: a new user signs in and round-trips one document against the *real* DB.
  No mocks, no seed users.

**M1 — Real-time editing**
- Stand up Hocuspocus; wire Tiptap collaboration; persist `ydoc_state`.
- `onStoreDocument` updates `documents.updated_at`/`last_editor_id`.
- DoD: two browsers edit the same doc live; reload restores content from Yjs;
  list shows accurate "edited … by …".

**M2 — Identity everywhere + presence**
- `useSession()`; nav/avatar; Yjs awareness presence with real names/colors.
- DoD: every surface shows the correct logged-in user; presence shows real
  collaborators with "(you)" on yourself.

**M3 — RBAC + sharing**
- roles/permissions/assignments seeded; `authorize()`; `my-access`; share dialog
  on assignments; ownership transfer.
- DoD: a viewer truly cannot edit (server-enforced); sharing grants real access;
  controls render per resolved role.

**M4 — Versioning & approval**
- snapshots; submit/approve/reject state machine; version history + diff;
  reviewer feedback; notifications.
- DoD: collaborator submits → manager sees pending → approve/reject transitions
  status and notifies; history + compare work.

**M5 — Comments & suggestions**
- anchored threaded comments; suggestions/track-changes; resolve; author names
  resolve for everyone.
- DoD: comments persist across reloads for all users; suggestions accept/reject
  write through.

**M6 — AI assist**
- inline command + async jobs; AI edits as suggestions with attribution.

**M7 — Hardening & launch**
- folders, search (from derived text), export, audit feed; observability;
  rate limits; backup/restore for Postgres + Yjs blobs; collab scaling (Redis +
  sticky sessions) if needed.

---

## 14. Testing strategy

- **Unit:** services + the `authorize()` permission table (table-driven; this is
  where security bugs hide).
- **Integration:** API against a real test Postgres (testcontainers/compose).
- **Contract:** in Option A, types are the contract (compiler-enforced); in
  Option B, fail CI if the generated client is out of date.
- **E2E:** Playwright on the critical journeys: login → create → edit → share →
  submit → approve → comment. Run against the real stack.
- **Collab:** a 2-client test that asserts convergence + reconnect.
- **Mocks (MSW) are for component tests only** — never a runtime mode.

---

## 15. Deployment & ops

- **Web:** Vercel (or container). **API + Collab:** containers (Fly/Railway/ECS).
  **DB:** managed Postgres. **Redis:** managed (only when scaling collab).
- Collab needs **sticky sessions** (a client stays pinned to one instance) and
  Redis pub/sub when running >1 instance.
- **Backups:** Postgres PITR **and** the Yjs blobs (they're your content — back
  them up like a database, because they are one).
- **Observability:** structured logs, error tracking (Sentry), a health check per
  service, and metrics on collab connections.
- Migrations via Drizzle/Alembic in CI — never auto-create schema in prod.

---

## 16. Risk register & de-risking

| Risk | Mitigation |
|------|------------|
| Collab scaling (sticky sessions, Redis) is hard | Start single-instance; or start on managed (Tiptap Cloud/Liveblocks), migrate later |
| Yjs blob = content with no SQL queryability | Maintain derived `plain_text`/excerpt for search; back up blobs |
| Auth complexity | Use managed auth for v1 |
| Editor integration depth (comments/suggestions) | Tiptap first-party extensions instead of hand-building on Slate |
| Scope/permission bugs | One `authorize()`, table-driven tests, org_id on every query |
| Team system-design inexperience | Vertical slices with hard DoD gates; walking skeleton first; this doc as the contract |
| Frontend/backend drift | tRPC (A) or generated client + CI drift check (B) |

---

## 17. How to drive the build in the new Claude Code session

Practical guidance so the rebuild goes smoothly with an agent:

1. **Seed the repo with this `plan.md` + a `CLAUDE.md`** (architecture, stack,
   conventions, the §0 principles). The agent should treat §0 as law.
2. **Work milestone by milestone (§13).** Start each with: "Implement M_n only;
   here is its Definition of Done; do not scope-creep." Stop at the DoD and
   verify before moving on.
3. **Demand the walking skeleton first.** No feature work until M0 round-trips
   real data with no mocks/seed users.
4. **Make type-safety non-negotiable.** Option A: no hand-written API types.
   Option B: regenerate the client whenever the backend changes; CI fails on
   drift.
5. **Enforce "one writer."** Whenever content appears, confirm it flows through
   Yjs, not a second store. Reject any PR that adds a parallel content cache.
6. **Keep the env real.** `docker-compose up` then build against it; never add a
   stub runtime to "make it work without the backend."
7. **Verify each slice** (Playwright + the DoD checklist) before the next.

---

## 18. What changes vs the old Docolab (summary)

| Area | Old (stalled) | VerDoc (this plan) |
|------|---------------|--------------------|
| Content store | REST/localStorage **and** Yjs (unreconciled) | Yjs only; relational = metadata; derived read-models |
| API typing | hand-mirrored, drifted | tRPC/generated, drift-proof |
| Runtime backend | stub + MSW + real (mixed) | one real backend; mocks = tests only |
| Auth | token in localStorage | in-memory access + HttpOnly refresh, or managed |
| AuthZ | re-derived ad hoc | one `authorize()`, server-gated, tested |
| Editor stack | Plate on Slate, hand-wired collab | Tiptap + Hocuspocus, first-party comments/suggestions/versions |
| Build approach | horizontal, half-built | vertical slices with DoD gates |
| Identity in UI | seeded "You" | one `useSession()` everywhere |

---

## Sources (research backing the recommendations)

- Hocuspocus scaling & persistence — [Tiptap Scalability](https://tiptap.dev/docs/hocuspocus/guides/scalability), [Persistence](https://tiptap.dev/docs/hocuspocus/guides/persistence), [Velt: Yjs WebSocket server guide](https://velt.dev/blog/yjs-websocket-server-real-time-collaboration)
- Managed vs self-hosted collab — [PkgPulse: Liveblocks vs PartyKit vs Hocuspocus 2026](https://www.pkgpulse.com/guides/liveblocks-vs-partykit-vs-hocuspocus-realtime-2026)
- Versioning as event sourcing / snapshots — [DjangoStars: collaborative editing system design](https://djangostars.com/blog/collaborative-editing-system-development/), [Tiptap Snapshot extension](https://tiptap.dev/docs/collaboration/documents/snapshot), [Tiptap Collaboration REST API](https://tiptap.dev/docs/collaboration/documents/rest-api)
- Editor comparison — [BuildPilot: Tiptap vs Lexical vs Plate 2026](https://trybuildpilot.com/609-tiptap-vs-lexical-vs-plate-editor-2026), [Liveblocks: which rich text editor framework](https://liveblocks.io/blog/which-rich-text-editor-framework-should-you-choose-in-2025)
- Auth pattern — [Crosscheck: Cookies vs JWT 2026](https://crosscheck.cloud/blogs/cookies-vs-jwt-authentication-2026/), [Duende: JWT best practices](https://duendesoftware.com/learn/best-practices-using-jwts-with-web-and-mobile-apps)
- Contract-first types — [FastAPI: generating clients](https://fastapi.tiangolo.com/advanced/generate-clients/), [Vinta: API clients in FastAPI+Next.js monorepos](https://www.vintasoftware.com/blog/nextjs-fastapi-monorepo)
- Multi-tenant RBAC — [WorkOS: multi-tenant RBAC](https://workos.com/blog/how-to-design-multi-tenant-rbac-saas), [Permit.io: multi-tenant authorization](https://www.permit.io/blog/best-practices-for-multi-tenant-authorization)
