"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionUser } from "@/server/auth";
import { tokenStore, trpc } from "./trpc";

interface SessionContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  applyAuth: (auth: { user: SessionUser; accessToken: string }) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const bootstrapped = useRef(false);

  const refresh = trpc.auth.refresh.useMutation();
  const logout = trpc.auth.logout.useMutation();

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    refresh
      .mutateAsync()
      .then((res) => {
        if (res.user && res.accessToken) {
          tokenStore.set(res.accessToken);
          setUser(res.user);
        }
      })
      .catch(() => {
        /* not logged in */
      })
      .finally(() => setIsLoading(false));
  }, []);

  const applyAuth: SessionContextValue["applyAuth"] = ({ user, accessToken }) => {
    tokenStore.set(accessToken);
    setUser(user);
  };

  const signOut: SessionContextValue["signOut"] = async () => {
    try {
      await logout.mutateAsync();
    } finally {
      tokenStore.set(null);
      setUser(null);
    }
  };

  return (
    <SessionContext.Provider value={{ user, isLoading, applyAuth, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within <SessionProvider>");
  return ctx;
}
