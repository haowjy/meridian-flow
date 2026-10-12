/** POST batched stored-link resolution: `(ref, href)` pairs in, answers in request order. */

import { serializeTransport } from "@meridian/contracts/protocol";
import { defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import {
  handleDocumentLinkResolveRequest,
  parseDocumentLinkResolveBody,
} from "../../../../../lib/document-link-route.js";

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const request = parseDocumentLinkResolveBody(await readBody(event));
  const response = await handleDocumentLinkResolveRequest(
    {
      projectRepo: app.projectRepo,
      documentLinks: app.documentLinks,
      linkScopes: app.linkScopes,
      workAuthorityResolver: app.workAuthorityResolver,
      fileAccess: app.fileAccess,
    },
    { projectId: getRouterParam(event, "projectId") ?? "", userId: user.userId, request },
  );
  return serializeTransport(response);
});
