import { randomBytes, randomUUID, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db, refreshTokens, users } from "@verdoc/db";
import { env } from "@/env";

export const REFRESH_COOKIE = "verdoc_refresh";
const ACCESS_TTL_SECONDS = 15 * 60; // 15 min
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const jwtSecret = new TextEncoder().encode(env.AUTH_JWT_SECRET);

export interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  avatarColor: string;
}

// --- Passwords --------------------------------------------------------------

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// --- Access tokens (in-memory on the client; short-lived) -------------------

export async function signAccessToken(user: SessionUser): Promise<string> {
  return new SignJWT({
    orgId: user.orgId,
    email: user.email,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(jwtSecret);
}

export async function verifyAccessToken(
  token: string,
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret);
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      orgId: String(payload.orgId),
      email: String(payload.email),
      displayName: String(payload.displayName),
      avatarColor: String(payload.avatarColor),
    };
  } catch {
    return null;
  }
}

// --- Refresh tokens: HttpOnly cookie + rotation + reuse detection -----------

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

async function setRefreshCookie(raw: string) {
  const jar = await cookies();
  jar.set(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_TTL_MS / 1000,
  });
}

export async function clearRefreshCookie() {
  const jar = await cookies();
  jar.delete(REFRESH_COOKIE);
}

/** Issue a brand-new token family (called on signup/login) and set the cookie. */
export async function startSession(userId: string): Promise<void> {
  const familyId = randomUUID();
  const raw = randomBytes(32).toString("hex");
  await db.insert(refreshTokens).values({
    userId,
    familyId,
    tokenHash: sha256(raw),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  await setRefreshCookie(raw);
}

async function revokeFamily(familyId: string) {
  await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(eq(refreshTokens.familyId, familyId));
}

/**
 * Validate the current refresh cookie, rotate it, and return the userId.
 * Returns null (and clears the cookie) when invalid/expired. On reuse of an
 * already-rotated token, revokes the whole family.
 */
export async function rotateSession(): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(REFRESH_COOKIE)?.value;
  if (!raw) return null;

  const hash = sha256(raw);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);

  if (!row) {
    await clearRefreshCookie();
    return null;
  }
  if (row.revoked) {
    // Reuse of a rotated token => credential theft signal: nuke the family.
    await revokeFamily(row.familyId);
    await clearRefreshCookie();
    return null;
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await clearRefreshCookie();
    return null;
  }

  // Rotate: revoke the presented token, mint a successor in the same family.
  const nextRaw = randomBytes(32).toString("hex");
  await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(eq(refreshTokens.id, row.id));
  await db.insert(refreshTokens).values({
    userId: row.userId,
    familyId: row.familyId,
    tokenHash: sha256(nextRaw),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  await setRefreshCookie(nextRaw);
  return row.userId;
}

/** Revoke the family for the current cookie (logout) and clear it. */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(REFRESH_COOKIE)?.value;
  if (raw) {
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, sha256(raw)))
      .limit(1);
    if (row) await revokeFamily(row.familyId);
  }
  await clearRefreshCookie();
}

/** Load a SessionUser by id (used after rotation). */
export async function loadSessionUser(
  userId: string,
): Promise<SessionUser | null> {
  const [u] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active")))
    .limit(1);
  if (!u) return null;
  return {
    id: u.id,
    orgId: u.orgId,
    email: u.email,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
  };
}
