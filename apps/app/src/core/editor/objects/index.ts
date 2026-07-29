/**
 * Object physics — the design's second register, headless.
 *
 * A lane that ships an object type adds a row to `EDITOR_OBJECT_TYPES` and,
 * when Enter opens a surface, registers the handler from its mounted React
 * component. Nothing else here is meant to be re-implemented per type.
 */

export {
  type ObjectEngagement,
  ObjectPhysicsExtension,
  objectPhysicsPluginKey,
  registerObjectEngagement,
  registerObjectKeymap,
} from "./ObjectPhysicsExtension";
export {
  caretBesideObjectTransaction,
  caretHomeFromObjectTransaction,
  caretInsideObjectTransaction,
  type ObjectAt,
  objectBeside,
  selectedObject,
  selectObjectTransaction,
} from "./object-selection";
export {
  EDITOR_OBJECT_TYPES,
  isEditorObject,
  isSourceBlock,
  type ObjectEngageIntent,
  type ObjectTypeSpec,
  objectTypeSpec,
} from "./object-types";
