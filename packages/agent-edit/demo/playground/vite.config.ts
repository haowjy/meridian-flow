// Throwaway Vite config for the agent-edit playground. Points React + the
// workspace `@meridian/agent-edit` package at the browser. Optimizer config
// keeps Yjs as a single instance so y-prosemirror's identity checks work.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
  },
  // Yjs must be a singleton across @meridian/agent-edit, y-prosemirror, and
  // our app code — otherwise PModel/Y.Doc instanceof checks fail silently.
  optimizeDeps: {
    include: ["yjs", "y-prosemirror"],
  },
});
