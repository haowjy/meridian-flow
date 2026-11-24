import { createArchitectureServer, send } from "./server.mjs";

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
