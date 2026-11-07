import { createServerFn } from "@tanstack/react-start";

import { getAppServerConfig } from "./config";

export const getLandingUrl = createServerFn({ method: "GET" }).handler(
  () => getAppServerConfig().landingUrl,
);
