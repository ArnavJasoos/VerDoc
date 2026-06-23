"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";

export default function Home() {
  const { user, isLoading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(user ? "/browser" : "/login");
  }, [user, isLoading, router]);

  return (
    <div className="center">
      <p className="empty">Loading…</p>
    </div>
  );
}
