"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "@/lib/session";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Client route guard + top bar. Redirects to /login when unauthenticated. */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, isLoading, signOut } = useSession();

  useEffect(() => {
    if (!isLoading && !user) router.replace("/login");
  }, [isLoading, user, router]);

  if (isLoading || !user) {
    return (
      <div className="center">
        <p className="empty">Loading…</p>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <Link href="/browser" className="brand" style={{ color: "var(--text)" }}>
          VerDoc
        </Link>
        <div className="who">
          <span
            className="avatar"
            style={{ background: user.avatarColor }}
            title={user.email}
          >
            {initials(user.displayName)}
          </span>
          <span>
            {user.displayName} <span style={{ opacity: 0.6 }}>(you)</span>
          </span>
          <button
            className="btn secondary"
            onClick={() => {
              void signOut().then(() => router.replace("/login"));
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      {children}
    </>
  );
}
