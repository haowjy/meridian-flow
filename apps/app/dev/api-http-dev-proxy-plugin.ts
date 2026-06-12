import https from "node:https";
import type { Plugin } from "vite";

import { resolveApiDevOriginForAppHost } from "../src/core/transport/dev-transport";
import { isApiOwnedPath, isAppOwnedAuthPath } from "../src/server/api-route-ownership";

export function apiHttpDevProxyPlugin(
  apiDevOriginFallback: string,
  proxyAgent?: https.Agent,
): Plugin {
  return {
    name: "meridian-api-http-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) {
          next();
          return;
        }

        const requestHost = req.headers.host ?? "app.meridian.localhost";
        const apiDevOrigin = resolveApiDevOriginForAppHost(requestHost, apiDevOriginFallback);
        const url = new URL(req.url, `https://${requestHost}`);
        const pathname = url.pathname;

        if (!pathname.startsWith("/api")) {
          next();
          return;
        }
        if (isAppOwnedAuthPath(pathname)) {
          next();
          return;
        }
        if (!isApiOwnedPath(pathname)) {
          next();
          return;
        }
        if (req.headers.upgrade?.toLowerCase() === "websocket") {
          next();
          return;
        }

        const target = new URL(req.url, apiDevOrigin);
        const proxyReq = https.request(
          target,
          {
            method: req.method,
            agent: proxyAgent,
            headers: {
              ...req.headers,
              host: target.host,
            },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 500, proxyRes.statusMessage, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );

        proxyReq.on("error", (error) => {
          if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 502;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end(`API dev proxy upstream TLS/request failure: ${error.message}`);
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
        });
        req.pipe(proxyReq);
      });
    },
  };
}
