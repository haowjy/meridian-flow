export { livePreviewPlugin, getLivePreviewExtension } from './plugin'
export { RendererRegistry, globalRendererRegistry } from './registry'
export { CLASSES, hideDecoration, markDecoration, lineDecoration } from './decorations'
export type { MarkdownRenderer, LivePreviewConfig, LivePreviewState } from './types'

// Re-export renderers for custom configurations
export {
  headingRenderer,
  emphasisRenderer,
  linkRenderer,
  inlineCodeRenderer,
  codeBlockRenderer,
} from './renderers'
