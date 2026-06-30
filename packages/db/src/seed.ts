import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "./index";
import {
  assignments,
  permissions,
  rolePermissions,
  roles,
  PERMISSION_KEYS,
  ROLE_NAMES,
  type RoleName,
  type ScopeType,
} from "./schema";
import { ROLE_PERMISSIONS } from "./rbac";

// Executor that also writes (base db or a transaction).
type WExecutor = Pick<typeof defaultDb, "select" | "insert">;

/** Upsert the global permission lookup (idempotent). */
export async function seedGlobalPermissions(exec: WExecutor = defaultDb) {
  await exec
    .insert(permissions)
    .values(PERMISSION_KEYS.map((key) => ({ key })))
    .onConflictDoNothing();
}

/**
 * Seed the four roles for an org and wire role_permissions from the matrix
 * (plan §6). Idempotent — safe to call again. Returns the org's role rows.
 */
export async function seedOrgRbac(exec: WExecutor, orgId: string) {
  await seedGlobalPermissions(exec);
  await exec
    .insert(roles)
    .values(ROLE_NAMES.map((name) => ({ orgId, name })))
    .onConflictDoNothing();

  const [orgRoles, allPerms] = await Promise.all([
    exec.select().from(roles).where(eq(roles.orgId, orgId)),
    exec.select().from(permissions),
  ]);
  const permId = new Map(allPerms.map((p) => [p.key, p.id]));

  const rp: { roleId: string; permissionId: string }[] = [];
  for (const r of orgRoles) {
    for (const key of ROLE_PERMISSIONS[r.name as RoleName] ?? []) {
      const pid = permId.get(key);
      if (pid) rp.push({ roleId: r.id, permissionId: pid });
    }
  }
  if (rp.length) {
    await exec.insert(rolePermissions).values(rp).onConflictDoNothing();
  }
  return orgRoles;
}

/**
 * Bind a user to a role at a scope (idempotent — re-granting updates the role).
 * "Creator owns": used to grant the creator `owner` at the new resource's scope.
 */
export async function grantAssignment(
  exec: WExecutor,
  args: {
    orgId: string;
    userId: string;
    roleName: RoleName;
    scopeType: ScopeType;
    scopeId: string;
  },
) {
  const [role] = await exec
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, args.orgId), eq(roles.name, args.roleName)))
    .limit(1);
  if (!role) throw new Error(`role ${args.roleName} not seeded for org`);

  await exec
    .insert(assignments)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      roleId: role.id,
      scopeType: args.scopeType,
      scopeId: args.scopeId,
    })
    .onConflictDoUpdate({
      target: [assignments.userId, assignments.scopeType, assignments.scopeId],
      set: { roleId: role.id },
    });
}
