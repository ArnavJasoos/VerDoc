import type { PermissionKey, RoleName } from "./schema";

// The single source of truth for what each role can do (plan §6). Seeding writes
// these into role_permissions per org; authorize() and its tests read the same
// matrix, so DB and code can never drift.
export const ROLE_PERMISSIONS: Record<RoleName, readonly PermissionKey[]> = {
  owner: [
    "can_view",
    "can_edit",
    "can_comment",
    "can_submit",
    "can_approve",
    "can_view_history",
    "can_share",
    "can_manage_members",
    "can_manage_policy",
    "can_transfer_ownership",
    "can_delete",
  ],
  approver: [
    "can_view",
    "can_edit",
    "can_comment",
    "can_submit",
    "can_approve",
    "can_view_history",
  ],
  editor: [
    "can_view",
    "can_edit",
    "can_comment",
    "can_submit",
    "can_view_history",
  ],
  viewer: ["can_view", "can_view_history"],
};

// Scope specificity for the document -> folder -> org walk; higher wins.
export const SCOPE_SPECIFICITY = {
  organization: 0,
  folder: 1,
  document: 2,
} as const;
