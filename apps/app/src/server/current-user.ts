import { createServerFn } from "@tanstack/react-start";
import { resolveCurrentUserFromRequest } from "./auth";

export const getCurrentUser = createServerFn({ method: "GET" }).handler(async () => {
  return resolveCurrentUserFromRequest();
});
