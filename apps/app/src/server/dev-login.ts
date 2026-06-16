import { createServerFn } from "@tanstack/react-start";
import { devLoginEnabled } from "./auth";

export const getDevLoginEnabled = createServerFn({ method: "GET" }).handler(async () => {
  return devLoginEnabled();
});
