/**
 * Dev only: the architecture map, served at /architecture/ by the dev server. The production
 * build never includes it (`apply: "serve"`). `configFile` is the project's map.config.mjs.
 */
import { createArchitectureServer, send } from "./server.mjs";

/** @param {string} configFile @returns {import("vite").Plugin} */
export function architectureMapPlugin(configFile) {
  return {
    name: "architecture-map",
    apply: "serve",
    async configureServer(server) {
      const handle = await createArchitectureServer(configFile);
      server.middlewares.use((req, res, next) => {
        const result =
          req.url && (req.method === "GET" || req.method === "HEAD")
            ? handle(req.url.split(/[?#]/)[0])
            : null;
        if (result) send(req, res, result);
        else next();
      });
    },
  };
}
