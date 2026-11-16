import { formatParsedContextUri, parseContextUri } from "@meridian/contracts/context-uri";
import { canonicalLeaf, storedFilename } from "@meridian/contracts/protocol";
import { segmentOf } from "@meridian/project-tree";
import { createError, defineEventHandler, getRouterParam, readBody } from "nitro/h3";
import { contextPortForProjectAuthorities } from "../../../../../domains/context/index.js";
import { requireProjectOwner } from "../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../lib/auth-gate.js";
import { parseSiblingPosition } from "../../../../../lib/context-destination.js";
import {
  contextErrorToHttp,
  throwContextWorkUnavailableHttpError,
} from "../../../../../lib/context-error-http.js";
import {
  containerOf,
  resolveLocatorUri,
  throwLocatorRefusal,
} from "../../../../../lib/context-locator.js";
import { parseContextMutationName } from "../../../../../lib/context-mutation-validation.js";
import {
  documentTarget,
  requireFileGrant,
  withEditGrants,
} from "../../../../../lib/file-access-http.js";
import { withDurableIntentInterruptBoundary } from "../../../../../shared/interrupt-boundary.js";

// Remove after tabs have reloaded onto protocol 2: https://github.com/haowjy/meridian-flow/issues/1613
export default defineEventHandler((event) =>
  withDurableIntentInterruptBoundary(async () => {
    const { app, user } = await requireAppUser(event);
    const projectId = getRouterParam(event, "projectId") ?? "";
    await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
    const body = (await readBody(event)) as {
      expected: { kind: "file"; nodeId: string };
      from: string;
      to: string;
      name?: unknown;
      position?: unknown;
    };
    if (
      !body ||
      typeof body !== "object" ||
      body.expected?.kind !== "file" ||
      typeof body.expected.nodeId !== "string" ||
      !body.expected.nodeId.trim()
    )
      throw createError({ statusCode: 400, message: "`expected` names the document to move" });
    const from = typeof body.from === "string" ? parseContextUri(body.from) : null;
    const to = typeof body.to === "string" ? parseContextUri(body.to) : null;
    if (!from?.ok || !to?.ok)
      throw createError({ statusCode: 400, message: "`from` and `to` must be context URIs" });
    const name = body.name === undefined ? undefined : parseContextMutationName(body.name, "name");
    const position = body.position === undefined ? undefined : parseSiblingPosition(body.position);
    const ends = await Promise.all(
      [body.from, body.to].map(async (uri) => {
        const result = await resolveLocatorUri(app, projectId, uri);
        if (!result.ok) return throwLocatorRefusal(result.error);
        if (result.value.scope === "chat")
          throw createError({ statusCode: 400, message: "Uploads can't be moved into or out of" });
        return result.value;
      }),
    );
    const destination = ends[1];
    if (!destination) throw new Error("Missing destination");
    const workIds = new Set(
      ends.flatMap((end) => (end.scope === "work" ? [end.authority.workId as string] : [])),
    );
    const port = await contextPortForProjectAuthorities({
      deps: { contextPorts: app.contextPorts, workAuthorityResolver: app.workAuthorityResolver },
      projectId,
      userId: user.userId,
      workIds,
      primaryWorkId: [...workIds][0] ?? null,
    });
    if (!port) throwContextWorkUnavailableHttpError("work_missing");
    const grants = [
      await requireFileGrant(
        app.fileAccess,
        user.userId,
        documentTarget(body.expected.nodeId),
        "edit",
      ),
      await requireFileGrant(
        app.fileAccess,
        user.userId,
        containerOf(destination, projectId),
        "edit",
      ),
    ];
    const located = await port.locate(body.expected.nodeId);
    if (!located.ok) contextErrorToHttp(located.error);
    if (!located.value) throw createError({ statusCode: 404, message: "Document not found" });
    const sourceUri = located.value.uri;
    const copied = await withEditGrants(app.fileAccess, grants, () =>
      port.copy({
        operationId: crypto.randomUUID(),
        sources: [{ uri: sourceUri, expected: body.expected }],
        destinationUri: body.to,
        ...(position ? { position } : {}),
      }),
    );
    if (!copied.ok) contextErrorToHttp(copied.error);
    const entry = copied.value.entries.find((each) => each.copiedFrom === body.expected.nodeId);
    if (!entry) throw new Error("Copy did not return its root");
    let path = entry.path.replace(/^\/+|\/+$/g, "");
    if (name && canonicalLeaf(name) !== canonicalLeaf(entry.name)) {
      const renamed = await withEditGrants(app.fileAccess, grants, () =>
        port.treeCommand(body.to, {
          make: (scope) => {
            const node = scope.writer.view(scope.view).nodes.get(entry.id);
            if (!node || node.kind === "folder") return { result: entry.name };
            const ext = node.name.lastIndexOf(".");
            const parsed = storedFilename(name, {
              extension: ext > 0 ? node.name.slice(ext + 1).toLowerCase() : "",
              editable: node.kind === "document",
              filetype: node.filetype,
            });
            if (!parsed.ok) return { result: entry.name };
            scope.writer.rename(
              scope.view,
              scope.actor,
              entry.id,
              parsed.name,
              parsed.filename.filetype && parsed.filename.filetype !== node.filetype
                ? parsed.filename.filetype
                : undefined,
            );
            const shown = scope.writer.view(scope.view).nodes.get(entry.id);
            return { result: shown ? segmentOf(shown) : entry.name };
          },
        }),
      );
      if (!renamed.ok) contextErrorToHttp(renamed.error);
      path = `${path.slice(0, path.lastIndexOf("/") + 1)}${renamed.value}`;
    }
    return {
      uri: formatParsedContextUri(to.value.scheme, path, to.value.authority),
      moved: { node: entry.id },
    };
  }),
);
