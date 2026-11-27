import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT) || 3000,
    // Bind exactly PORT and keep `strictPort`: `pnpm dev`, `./mf` and the tests all compute this port, so a server that moved to a free one is unreachable
    strictPort: true,
    allowedHosts: [".localhost", ".ts.net"],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
    }),
    viteReact(),
    nitro(),
  ],
});
