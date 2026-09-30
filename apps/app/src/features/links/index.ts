/**
 * Following an internal link, for any surface that shows one.
 *
 * A surface supplies its resolution scope, its destination, and a host for the
 * outcome; everything between (the resolver, the per-scope cache registration,
 * the checking delay, the outcome states, and create-on-miss) lives here.
 */

export { FollowOutcomeContent, followOutcomeTitle } from "./FollowOutcomeContent";
export type { FollowReporter, LinkDestination, LinkDocumentRef } from "./follow-link";
export type { LinkResolutionScope } from "./project-link-resolver";
export { type LinkFollower, useLinkFollower } from "./use-link-follower";
export {
  type LinkableDocument,
  type LinkableDocumentIndex,
  useLinkableDocuments,
} from "./useLinkableDocuments";
