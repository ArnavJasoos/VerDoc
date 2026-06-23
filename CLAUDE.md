# VerDoc — agent working notes

Read `plan.md` first. §0 principles are **law**. Build in vertical slices (§13), DoD gates.

## Stack (Option A — all-TypeScript)

- Monorepo: pnpm workspaces + Turborepo.
- Web + tRPC: Next.js (App Router) in `apps/web`. tRPC router is the API contract — **no hand-written API types**.
- DB: PostgreSQL + Drizzle in `packages/db` (schema is the source of truth).
- Auth: minimal self-hosted (§5.2) — in-memory access JWT + HttpOnly refresh cookie, rotation + reuse detection.
- Editor: Tiptap (local-only in M0; Hocuspocus collab arrives M1).

## Deliberate deviations from plan §11

- **No separate `apps/api` yet.** For M0 the walking skeleton runs as a single Next.js
  process hosting tRPC via a route handler (T3-style). A standalone `apps/api` /
  `apps/collab` split is introduced at **M1**, when the Hocuspocus collab server needs
  to be its own deployable sharing the same auth secret. This honors §0's "minimize
  moving parts" without violating "one real backend."

## Hard rules (from §0)

1. One writer per state. Live doc body = Yjs only (from M1). `documents` row = metadata.
2. Type-safe by construction: tRPC end-to-end, no hand-mirrored types.
3. One real backend per env. Mocks are for tests only — never a runtime mode.
4. Server is the only authz gate (single `authorize()`, arriving M3).
5. Vertical slices; do not scope-creep past the current milestone's DoD.

## M0 Definition of Done

New user signs up/logs in → sees empty doc list → creates a blank doc → opens it
(local Tiptap) → it appears in the list. Against the **real** Postgres. No mocks, no
seed users.

## Commands

- `pnpm install` — install all workspaces
- `pnpm db:generate` then `pnpm db:migrate` — Drizzle migrations
- `pnpm dev` — run web (http://localhost:3000)
- `pnpm typecheck` / `pnpm lint` / `pnpm build`
