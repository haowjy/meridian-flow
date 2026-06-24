import { describe, expect, it } from "vitest";
import { formatDevRouteLines, validateExpectedRoutes } from "../portless-routes";

const PORTLESS_LIST_WITHOUT_SHARE_LINES = `
Active routes:

  https://agent-edit-tools.app.meridian.localhost  ->  localhost:4988  (pid 111)
  https://agent-edit-tools.server.meridian.localhost  ->  localhost:4101  (pid 222)
  https://agent-edit-tools.web.meridian.localhost  ->  localhost:4483  (pid 333)
`;

describe("portless route formatting", () => {
  it("accepts local portless routes without portless-managed tailscale shares", () => {
    expect(
      validateExpectedRoutes({
        output: PORTLESS_LIST_WITHOUT_SHARE_LINES,
        mode: "tailscale",
        worktreePrefix: "agent-edit-tools",
      }),
    ).toMatchObject({ ok: true, servicePids: { app: 111, server: 222, www: 333 } });
  });

  it("prints tools/dev-owned tailscale URLs", () => {
    expect(
      formatDevRouteLines(PORTLESS_LIST_WITHOUT_SHARE_LINES, "tailscale", "agent-edit-tools", [
        {
          service: "app",
          mode: "serve",
          httpsPort: 47111,
          url: "https://node.ts.net:47111",
        },
        {
          service: "www",
          mode: "serve",
          httpsPort: 47222,
          url: "https://node.ts.net:47222",
        },
      ]),
    ).toEqual([
      "app  local  https://agent-edit-tools.app.meridian.localhost",
      "app  ts     https://node.ts.net:47111",
      "www  local  https://agent-edit-tools.web.meridian.localhost",
      "www  ts     https://node.ts.net:47222",
      "server  local  https://agent-edit-tools.server.meridian.localhost",
    ]);
  });
});
