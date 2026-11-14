/** What a project's sources are, as its tree list names them by id. */
import type { ContextSourceId, DocumentId, ProjectId, UserId } from "@meridian/contracts";
import type { ContextSource, ContextSourceOwner } from "@meridian/contracts/protocol";

export interface ContextSources {
  /** Every source the project's owner can read: the project's, each Work's, each lineage's, each chat's. */
  inProject(projectId: ProjectId): Promise<ContextSource[]>;
  /** The account's own `user://` source. */
  ofUser(userId: UserId): Promise<ContextSource[]>;
  /** One owner's sources in a project: where a link's address lands. */
  ownedBy(projectId: ProjectId, owner: ContextSourceOwner): Promise<ContextSource[]>;
  /** The documents a source's live tree places, each with its source-relative path (filename included). */
  liveDocuments(sourceId: ContextSourceId): Promise<{ id: DocumentId; path: string }[]>;
}
