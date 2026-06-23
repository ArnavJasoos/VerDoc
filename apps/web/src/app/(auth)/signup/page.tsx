"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { trpc } from "@/lib/trpc";

export default function SignupPage() {
  const router = useRouter();
  const { applyAuth } = useSession();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signup = trpc.auth.signup.useMutation({
    onSuccess: (res) => {
      applyAuth(res);
      router.replace("/browser");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    signup.mutate({ displayName, email, password });
  }

  return (
    <div className="center">
      <form className="card" onSubmit={onSubmit}>
        <h1>Create your workspace</h1>
        <p className="sub">Start a new VerDoc workspace</p>
        {signup.error && <p className="error">{signup.error.message}</p>}
        <div className="field">
          <label htmlFor="name">Display name</label>
          <input
            id="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        </div>
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>
        <button className="btn" type="submit" disabled={signup.isPending}>
          {signup.isPending ? "Creating…" : "Create account"}
        </button>
        <p className="switch">
          Already have an account? <Link href="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
