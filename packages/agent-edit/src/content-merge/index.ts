/** `@meridian/agent-edit/content-merge`: the three-way block merge, and what an AI edit's change is in a text now. */

export { contentMerge } from "./merge.js";
export {
  captureDelta,
  changeStateIn,
  editChanges,
  readDelta,
  type StoredDelta,
  takeBack,
  takeOut,
} from "./stands.js";
