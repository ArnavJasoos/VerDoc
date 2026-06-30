import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
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

export const documents = pgTable("documents", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Untitled"),
  status: text("status").notNull().default("working"),
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
});

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

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type YdocState = typeof ydocState.$inferSelect;
