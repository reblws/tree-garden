import { Schema } from 'effect'

import { LSystemParams } from '../params/lsystem'
import { Camera } from '../render/camera'
import { PrintSize } from '../render/print'
import { RenderStyle } from '../render/renderStyle'
import { RevealMode } from '../render/revealMode'
import { Season } from '../render/season'
import { PlateOrientation } from '../render/sheet'

export const ParseError = Schema.Struct({ line: Schema.Number, message: Schema.String })
export type ParseError = typeof ParseError.Type

/** Facts about a finished build. The geometry itself lives in the
 *  GeometryStore under `buildId`, outside the Model. */
export const BuildStats = Schema.Struct({
  buildId: Schema.Number,
  symbolCount: Schema.Number,
  segmentCount: Schema.Number,
  iterationsApplied: Schema.Number,
  truncated: Schema.Boolean,
  preview: Schema.String,
  elapsedMs: Schema.Number,
  /** Width ÷ height of the plant's box: which way its sheet turns
   *  (render/sheet.ts). */
  aspect: Schema.Number,
})
export type BuildStats = typeof BuildStats.Type

export const Playback = Schema.Struct({
  mode: RevealMode,
  /** 0..1, how much of the plant is revealed. */
  progress: Schema.Number,
  isPlaying: Schema.Boolean,
})
export type Playback = typeof Playback.Type

/** Where the print is: not asked for (or delivered), being painted, or
 *  failed (the browser ran out of room for the canvas, say). */
export const PrintStatus = Schema.Literals(['Idle', 'Preparing', 'Failed'])
export type PrintStatus = typeof PrintStatus.Type

export const Model = Schema.Struct({
  params: LSystemParams,
  /** The preset the params came from, or '' once the user edits them. */
  presetId: Schema.String,
  /** Id of the most recent generation request. Results with any other id
   *  are stale and dropped. */
  latestBuildId: Schema.Number,
  /** The build on screen. Kept while a newer build is generating, and when
   *  the rules stop parsing, so the canvas never flashes empty. */
  shown: Schema.Option(BuildStats),
  errors: Schema.Array(ParseError),
  playback: Playback,
  /** How the plate is painted. A viewing choice, so not part of the link. */
  renderStyle: RenderStyle,
  /** The leaves' palette in the Leaf style. A viewing choice, so not part
   *  of the link. */
  season: Season,
  /** Zoom and centre of the view on the plate (render/camera.ts). Three
   *  numbers, plate-relative, so they survive resizes and rebuilds. A
   *  viewing choice, so not part of the link. */
  camera: Camera,
  /** Which way the sheet on screen is turned. It follows the plant shown
   *  (`orientationOf`), but only once an edit is committed and the view is
   *  fitted, so it never turns under a dragging slider or a zoomed view.
   *  A viewing state, so not part of the link. */
  orientation: PlateOrientation,
  /** A slider is being dragged or a field typed in: the edit isn't
   *  committed yet, so the sheet keeps its orientation. */
  isEditing: Schema.Boolean,
  isLinkCopied: Schema.Boolean,
  /** The sheet the print is made for. A choice of output, not of the
   *  plant, so not part of the link. */
  printSize: PrintSize,
  printStatus: PrintStatus,
})
export type Model = typeof Model.Type
