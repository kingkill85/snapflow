import type Konva from 'konva'

import type { Size } from '@/canvas'

/** Names of canvas nodes that are UI, not content: left out of the PNG export. */
export const chromeName = 'chrome'

/**
 * One screen pixel in image pixels while the export draws: strokes, handles and
 * labels as at 100 % zoom for images up to 1200 px, and as if the image were
 * shown 1200 px wide for bigger ones, so they stay readable on the whole image
 * whatever the zoom was (D217).
 */
export function exportPixel(image: Size): number {
  return Math.max(1, Math.max(image.width, image.height) / 1200)
}

/** "<project number> <plan name>.png" without characters file systems refuse. */
export function exportFileName(projectNumber: string, planName: string): string {
  const base = [...`${projectNumber} ${planName}`]
    .map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
    .join('')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return `${base || 'plan'}.png`
}

/**
 * The stage's content as a PNG blob at the image's natural resolution: the image
 * area (0,0)–(width,height) of the drawing, whatever the zoom; nodes named
 * `chrome` (selection, handles, drafts) are hidden while it is drawn.
 */
export function stageToPng(stage: Konva.Stage, image: Size): Promise<Blob> {
  const chrome = stage.find(`.${chromeName}`).filter((n) => n.visible())
  const scale = stage.scale()
  const position = stage.position()
  for (const n of chrome) n.visible(false)
  // Drawn at 1:1 from the image origin: exactly the image's pixels, whatever the zoom.
  stage.scale({ x: 1, y: 1 })
  stage.position({ x: 0, y: 0 })
  let canvas: HTMLCanvasElement
  try {
    // Drawn synchronously, so the stage is restored right after; encoding runs off the main thread.
    canvas = stage.toCanvas({ x: 0, y: 0, width: image.width, height: image.height, pixelRatio: 1 })
  } finally {
    stage.scale(scale)
    stage.position(position)
    for (const n of chrome) n.visible(true)
    stage.batchDraw()
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))), 'image/png'))
}

/** Saves a blob as a file (an object URL, revoked once the download has started). */
export function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = url
  a.download = fileName
  window.document.body.append(a)
  a.click()
  a.remove()
  // Revoked a little later: some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
