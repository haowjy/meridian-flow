import { createStart } from "@tanstack/react-start";

import { contentSecurityPolicyMiddleware } from "./server/content-security-policy";
import { meridianAuthkitMiddleware } from "./server/meridian-authkit-middleware";

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [contentSecurityPolicyMiddleware(), meridianAuthkitMiddleware()],
  };
});
