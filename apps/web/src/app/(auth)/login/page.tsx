"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { trpc } from "@/lib/trpc";

export default function LoginPage() {
  const router = useRouter();
  const { applyAuth } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = trpc.auth.login.useMutation({
    onSuccess: (res) => {
      applyAuth(res);
      router.replace("/browser");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate({ email, password });
  }

  return (
    <div className="center">
      <form className="card" onSubmit={onSubmit}>
        <h1>Welcome back</h1>
        <p className="sub">Log in to your VerDoc workspace</p>
        {login.error && <p className="error">{login.error.message}</p>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={login.isPending}>
          {login.isPending ? "Logging in…" : "Log in"}
        </button>
        <p className="switch">
          No account? <Link href="/signup">Sign up</Link>
        </p>
      </form>
    </div>
  );
}
