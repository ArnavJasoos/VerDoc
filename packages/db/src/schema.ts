import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Postgres BYTEA <-> Node Buffer. The Yjs document state is a binary blob
// (plan §2.1); it is the sole source of truth for live body content.
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// --- Identity & tenancy -----------------------------------------------------

export const organizations = pgTable("organizations", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarColor: text("avatar_color").notNull().default("#6366f1"),
    passwordHash: text("password_hash").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailPerOrg: unique("users_org_email_unique").on(t.orgId, t.email),
  }),
);

// --- Auth: refresh-token rotation + reuse detection (plan §5.2) -------------

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // All tokens descended from one login share a family; a reused (already-rotated)
  // token revokes the whole family.
  familyId: uuid("family_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Documents (metadata only; body lives in Yjs from M1) -------------------

export const documents = pgTable(
  "documents",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // Optional folder placement; the RBAC scope walk is document -> folder ->
    // org (plan §6). Deleting a folder detaches its documents, never deletes
    // them. (Forward reference to `folders`, declared below.)
    folderId: uuid("folder_id").references((): AnyPgColumn => folders.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull().default("Untitled"),
    // Approval state machine (plan §2.4); mutated ONLY by versionsService.
    status: text("status").notNull().default("working"),
    currentVersionNo: integer("current_version_no").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    lastEditorId: uuid("last_editor_id").references(() => users.id),
    trashed: boolean("trashed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index("documents_org_idx").on(t.orgId),
    folderIdx: index("documents_folder_idx").on(t.folderId),
    statusValid: check(
      "documents_status_check",
      sql`${t.status} in ('working','pending_approval','approved')`,
    ),
  }),
);

// --- Live document body: Yjs state blob (plan §2.1, written by collab server)

export const ydocState = pgTable("ydoc_state", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  state: bytea("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Folders (structure; an RBAC scope between document and org) -------------

export const folders = pgTable(
  "folders",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentFolderId: uuid("parent_folder_id").references(
      (): AnyPgColumn => folders.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index("folders_org_idx").on(t.orgId),
    parentIdx: index("folders_parent_idx").on(t.parentFolderId),
  }),
);

// --- Access control (RBAC, plan §6) -----------------------------------------
// One model, one gate. Roles are per-org; permissions are a global lookup;
// role_permissions links them; assignments bind a user to a role at a scope
// (organization | folder | document). Effective role on a resource = the most
// specific assignment walking document -> folder(s) -> org.

export const ROLE_NAMES = ["owner", "approver", "editor", "viewer"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const PERMISSION_KEYS = [
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
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const SCOPE_TYPES = ["organization", "folder", "document"] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const roles = pgTable(
  "roles",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // one of ROLE_NAMES
  },
  (t) => ({
    rolePerOrg: unique("roles_org_name_unique").on(t.orgId, t.name),
    // Defense-in-depth beyond the TS union: reject unknown role names at the DB.
    nameValid: check(
      "roles_name_check",
      sql`${t.name} in ('owner','approver','editor','viewer')`,
    ),
  }),
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    key: text("key").notNull().unique(), // one of PERMISSION_KEYS
  },
  (t) => ({
    keyValid: check(
      "permissions_key_check",
      sql`${t.key} in ('can_view','can_edit','can_comment','can_submit','can_approve','can_view_history','can_share','can_manage_members','can_manage_policy','can_transfer_ownership','can_delete')`,
    ),
  }),
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: unique("role_permissions_pk").on(t.roleId, t.permissionId),
    permissionIdx: index("role_permissions_permission_idx").on(t.permissionId),
  }),
);

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(), // one of SCOPE_TYPES
    scopeId: uuid("scope_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One role per user per scope (re-sharing updates rather than duplicates).
    oneRolePerScope: unique("assignments_user_scope_unique").on(
      t.userId,
      t.scopeType,
      t.scopeId,
    ),
    // Hot path: authorize() filters by (userId, scopeId IN (...)).
    byUserScope: index("assignments_user_scope_idx").on(t.userId, t.scopeId),
    roleIdx: index("assignments_role_idx").on(t.roleId),
    orgIdx: index("assignments_org_idx").on(t.orgId),
    scopeTypeValid: check(
      "assignments_scope_type_check",
      sql`${t.scopeType} in ('organization','folder','document')`,
    ),
  }),
);

// --- Versioning & approval (plan §2.3 / §2.4) -------------------------------

export const VERSION_KINDS = ["submission", "approved", "autosave"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

// Immutable, append-only snapshot of the Yjs state at a point in time. Written
// only by versionsService; never updated or deleted.
export const versions = pgTable(
  "versions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    kind: text("kind").notNull(), // one of VERSION_KINDS
    ydocSnapshot: bytea("ydoc_snapshot").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    // Derived read-model (plan §2.2): plain text of the snapshot, for diffing
    // without re-decoding the blob. The blob remains the source of truth.
    meta: jsonb("meta").$type<{ plainText?: string }>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    perDoc: unique("versions_doc_no_unique").on(t.documentId, t.versionNo),
    docIdx: index("versions_doc_idx").on(t.documentId),
    // Serves the approve/reject "latest submission" lookup
    // (documentId, kind='submission') order by versionNo desc.
    docKindNoIdx: index("versions_doc_kind_no_idx").on(
      t.documentId,
      t.kind,
      t.versionNo,
    ),
    kindValid: check(
      "versions_kind_check",
      sql`${t.kind} in ('submission','approved','autosave')`,
    ),
  }),
);

// Reviewer feedback attached to a submitted version (plan §2.4 reject path).
export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionIdx: index("recommendations_version_idx").on(t.versionId),
  }),
);

// Per-user activity (plan §3). Written in the same transaction as the state
// transition that triggers it, so a transition is never silently un-notified.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byUser: index("notifications_user_idx").on(t.userId),
    // Partial index for unreadCount / markAllRead (userId, readAt IS NULL).
    unread: index("notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  }),
);

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type YdocState = typeof ydocState.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type Assignment = typeof assignments.$inferSelect;
export type Version = typeof versions.$inferSelect;
export type Recommendation = typeof recommendations.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
