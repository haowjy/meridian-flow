// @ts-nocheck
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify({ status: "ok", service: "app" }), {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        }),
    },
  },
});
