/** /api/auth/callback route — placeholder for callback-based Supabase auth flows. */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: async () => new Response(null, { status: 302, headers: { Location: "/auth-check" } }),
    },
  },
});
