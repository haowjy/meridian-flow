/** `@meridian/agent-edit/content-merge`: the three-way block merge, and what an AI edit's change is in a text now. */

export { contentMerge } from "./merge.js";
export {
  captureDelta,
  changeStateIn,
  type EditChange,
  editChanges,
  readDelta,
  type StoredDelta,
  takeOut,
} from "./stands.js";
