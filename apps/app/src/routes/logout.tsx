/** /logout route — clears Meridian's Supabase session cookies. */
import { createFileRoute } from "@tanstack/react-router";
import { serializeClearedSupabaseSessionCookies } from "@/server/auth";

export const Route = createFileRoute("/logout")({
  preload: false,
  server: {
    handlers: {
      GET: async () => {
        const headers = new Headers({ Location: "/login" });
        for (const cookie of serializeClearedSupabaseSessionCookies()) {
          headers.append("Set-Cookie", cookie);
        }
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
