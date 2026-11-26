import http from "node:http";
import https from "node:https";
import type { Plugin } from "vite";

import { getApiRouteOwner } from "../src/server/api-route-ownership";

export function shouldProxyApiHttpPath(pathname: string, isWebSocket = false): boolean {
  return !isWebSocket && getApiRouteOwner(pathname) === "server";
}

export function apiHttpDevProxyPlugin(apiDevOrigin: string): Plugin {
  const request = new URL(apiDevOrigin).protocol === "https:" ? https.request : http.request;
  return {
    name: "meridian-api-http-dev-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) {
          next();
          return;
        }

        const pathname = new URL(req.url, apiDevOrigin).pathname;

        if (!shouldProxyApiHttpPath(pathname, req.headers.upgrade?.toLowerCase() === "websocket")) {
          next();
          return;
        }

        const target = new URL(req.url, apiDevOrigin);
        // keep: Host is forwarded unchanged; the server's dev sign-in rule compares Origin with it
        const proxyReq = request(
          target,
          { method: req.method, headers: req.headers },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 500, proxyRes.statusMessage, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );

        proxyReq.on("error", (error) => {
          if (!res.headersSent && !res.writableEnded) {
            res.statusCode = 502;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end(`API dev proxy upstream request failure: ${error.message}`);
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
        });
        res.on("close", () => {
          if (!res.writableFinished) proxyReq.destroy();
        });
        req.pipe(proxyReq);
      });
    },
  };
}
