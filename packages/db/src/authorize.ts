import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "./index";
import {
  assignments,
  documents,
  folders,
  roles,
  type PermissionKey,
  type RoleName,
  type ScopeType,
} from "./schema";
import { ROLE_PERMISSIONS } from "./rbac";

// Structural executor so the same code runs on the base db OR inside a
// transaction (both expose these query builders).
export type Executor = Pick<typeof defaultDb, "select">;

export interface AuthzResult {
  allowed: boolean;
  resolvedRole: RoleName | null;
  viaScope: { type: ScopeType; id: string } | null;
}

const DENY: AuthzResult = { allowed: false, resolvedRole: null, viaScope: null };

interface ScopeRef {
  type: ScopeType;
  id: string;
}

// Folder + ancestors, most-specific first; stops at the org boundary or a cycle.
async function folderChain(
  exec: Executor,
  startId: string | null,
  orgId: string,
): Promise<ScopeRef[]> {
  const out: ScopeRef[] = [];
  let fid: string | null = startId;
  let guard = 0;
  while (fid && guard++ < 50) {
    const [f] = await exec
      .select({
        id: folders.id,
        parent: folders.parentFolderId,
        orgId: folders.orgId,
      })
      .from(folders)
      .where(eq(folders.id, fid))
      .limit(1);
    if (!f || f.orgId !== orgId) break; // missing or cross-org → stop
    out.push({ type: "folder", id: f.id });
    fid = f.parent;
  }
  return out;
}

// Most-specific-first scope chain for a resource: document → folder(s) → org.
// Returns null if the resource is missing or belongs to another org (which is
// itself a denial — no cross-org access, plan §6).
async function buildScopeChain(
  exec: Executor,
  scopeType: ScopeType,
  scopeId: string,
  orgId: string,
): Promise<ScopeRef[] | null> {
  const chain: ScopeRef[] = [];

  if (scopeType === "document") {
    const [doc] = await exec
      .select({ orgId: documents.orgId, folderId: documents.folderId })
      .from(documents)
      .where(eq(documents.id, scopeId))
      .limit(1);
    if (!doc || doc.orgId !== orgId) return null;
    chain.push({ type: "document", id: scopeId });
    chain.push(...(await folderChain(exec, doc.folderId, orgId)));
  } else if (scopeType === "folder") {
    const fc = await folderChain(exec, scopeId, orgId);
    if (fc.length === 0) return null; // missing or cross-org folder
    chain.push(...fc);
  }
  // Org is always the least-specific fallback scope.
  chain.push({ type: "organization", id: orgId });
  return chain;
}

/**
 * The single authorization gate (plan §6). Resolves the user's effective role on
 * a resource by walking document → folder(s) → org and taking the role from the
 * MOST SPECIFIC assignment found, then checks that role against the permission
 * matrix. Returns {allowed, resolvedRole, viaScope}.
 *
 * - No cross-org access: a resource in another org resolves to a denial.
 * - Pass `exec` to run inside a transaction (e.g. ownership transfer).
 */
export async function authorize(args: {
  userId: string;
  orgId: string;
  permission: PermissionKey;
  scopeType: ScopeType;
  scopeId: string;
  exec?: Executor;
}): Promise<AuthzResult> {
  const exec = args.exec ?? defaultDb;
  const chain = await buildScopeChain(
    exec,
    args.scopeType,
    args.scopeId,
    args.orgId,
  );
  if (!chain) return DENY;

  const rows = await exec
    .select({
      scopeType: assignments.scopeType,
      scopeId: assignments.scopeId,
      role: roles.name,
    })
    .from(assignments)
    .innerJoin(roles, eq(assignments.roleId, roles.id))
    .where(
      and(
        eq(assignments.userId, args.userId),
        // Enforce tenant + scope-type isolation in SQL (defense-in-depth), not
        // only via the post-fetch map keying / UUID non-collision.
        eq(assignments.orgId, args.orgId),
        inArray(assignments.scopeType, [
          ...new Set(chain.map((c) => c.type)),
        ]),
        inArray(
          assignments.scopeId,
          chain.map((c) => c.id),
        ),
      ),
    );

  const byScope = new Map<string, string>();
  for (const r of rows) byScope.set(`${r.scopeType}:${r.scopeId}`, r.role);

  for (const sc of chain) {
    const roleName = byScope.get(`${sc.type}:${sc.id}`);
    if (roleName) {
      const role = roleName as RoleName;
      const allowed = (ROLE_PERMISSIONS[role] ?? []).includes(args.permission);
      return { allowed, resolvedRole: role, viaScope: { type: sc.type, id: sc.id } };
    }
  }
  return DENY;
}
