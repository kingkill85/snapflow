// The shared canvas base for plans of every kind (floorplans now, boards later).
export { type CanvasPointer, CanvasStage, ImageLayer } from './CanvasStage'
export * from './geometry'
export { isCanvasKeyTarget, isModKey, isTypingTarget } from './keyboard'
export { type CanvasTheme, useCanvasTheme } from './theme'
export { useHtmlImage, useHtmlImages } from './use-html-image'
export { useViewport } from './use-viewport'
