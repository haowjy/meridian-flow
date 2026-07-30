/**
 * Object physics — the design's second register, headless.
 *
 * A lane that ships an object type adds a row to `EDITOR_OBJECT_TYPES` and,
 * when Enter opens a surface, registers the handler from its mounted React
 * component. Nothing else here is meant to be re-implemented per type.
 */

export {
  engageObject,
  type ObjectEngagement,
  type ObjectOpening,
  ObjectPhysicsExtension,
  objectPhysicsPluginKey,
  registerObjectEngagement,
  registerObjectKeymap,
} from "./ObjectPhysicsExtension";
export {
  caretBesideObjectTransaction,
  caretHomeFromObjectTransaction,
  caretInsideObjectTransaction,
  gapCursorFits,
  type ObjectAt,
  objectBeside,
  opaqueObjectAround,
  selectedObject,
  selectObjectTransaction,
} from "./object-selection";
export {
  EDITOR_OBJECT_TYPES,
  isEditorObject,
  isOpaqueObject,
  isSourceBlock,
  type ObjectBody,
  type ObjectEngageIntent,
  type ObjectSurfaceField,
  type ObjectSurfaceKind,
  type ObjectTypeSpec,
  objectBody,
  objectSurfaceFields,
  objectSurfaceKind,
  objectTypeSpec,
} from "./object-types";
