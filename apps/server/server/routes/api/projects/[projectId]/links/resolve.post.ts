/** POST project link resolution over the context domain's internal-link port. */

import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleDocumentLinkResolveRequest,
  parseDocumentLinkResolveBody,
} from "../../../../../lib/document-link-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const body = parseDocumentLinkResolveBody(await readBody(event));
  const response = await handleDocumentLinkResolveRequest(
    {
      projectRepo: app.projectRepo,
      documentLinks: app.documentLinks,
    },
    {
      projectId: getRouterParam(event, "projectId") ?? "",
      userId: user.userId,
      ...body,
    },
  );
  return serializeTransport(response);
});
