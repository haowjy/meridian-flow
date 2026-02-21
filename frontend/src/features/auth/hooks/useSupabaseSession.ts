import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/core/supabase/client";
import { makeLogger } from "@/core/lib/logger";
import type { SessionStatus } from "../types";

const log = makeLogger("use-supabase-session");

/**
 * Low-level hook for Supabase session state.
 *
 * Single Responsibility: Subscribe to Supabase auth state changes.
 * Does NOT transform data or handle sign out - just observes.
 */
export function useSupabaseSession(): {
  session: Session | null;
  status: SessionStatus;
} {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  // Track current session so the .catch() can avoid clobbering a valid session
  // that onAuthStateChange already delivered.
  const sessionRef = useRef<Session | null>(null);

  useEffect(() => {
    let mounted = true;
    const supabase = createClient();

    // Get initial session
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (!mounted) return;
        sessionRef.current = session;
        setSession(session);
        setStatus(session ? "authenticated" : "unauthenticated");
      })
      .catch((err) => {
        log.error("Failed to load auth session", err);
        if (!mounted) return;
        // Only fall back to unauthenticated if onAuthStateChange hasn't
        // already delivered a valid session (race: listener fires before
        // getSession resolves/rejects).
        if (!sessionRef.current) {
          setStatus("unauthenticated");
        }
      });

    // Subscribe to auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      sessionRef.current = session;
      setSession(session);
      setStatus(session ? "authenticated" : "unauthenticated");
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, status };
}
