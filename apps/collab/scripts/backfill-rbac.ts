import "../src/load-env";

import { db, organizations, users, seedOrgRbac, grantAssignment } from "@verdoc/db";

// One-time, idempotent backfill for orgs/users created before M3 added RBAC
// seeding. Each pre-M3 signup created its own single-member org, so the member
// is restored as org owner — matching the M3 "creator owns" rule.
const orgs = await db.select({ id: organizations.id }).from(organizations);
for (const o of orgs) await seedOrgRbac(db, o.id);

const us = await db.select({ id: users.id, orgId: users.orgId }).from(users);
for (const u of us) {
  await grantAssignment(db, {
    orgId: u.orgId,
    userId: u.id,
    roleName: "owner",
    scopeType: "organization",
    scopeId: u.orgId,
  });
}

console.log(`[backfill] seeded ${orgs.length} orgs, granted owner to ${us.length} users`);
process.exit(0);
