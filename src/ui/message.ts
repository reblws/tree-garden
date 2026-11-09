import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'
import { Url } from 'foldkit/url'

import { Camera, PanStep, ZoomStep } from '../render/camera'
import { PrintSize } from '../render/print'
import { RenderStyle } from '../render/renderStyle'
import { RevealMode } from '../render/revealMode'
import { Season } from '../render/season'
import { BuildStats, ParseError } from './model'

export const Message = defineMessageUnion({
  // Editing parameters. Each one regenerates the plant immediately.
  SelectedPreset: { presetId: Schema.String },
  ChangedAxiom: { value: Schema.String },
  ChangedRules: { value: Schema.String },
  ChangedIterations: { value: Schema.Number },
  ChangedAngle: { value: Schema.Number },
  ChangedJitter: { value: Schema.Number },
  ChangedSeed: { value: Schema.String },
  /** A slider was released or a text field lost focus: write the URL.
   *  Kept separate from the Changed* messages so dragging a slider doesn't
   *  call history.replaceState sixty times a second. */
  CommittedEdit: {},
  ClickedNewSeed: {},
  GotNewSeed: { seed: Schema.String },

  // Generation results.
  CompletedGenerate: { stats: BuildStats },
  FailedGenerate: { buildId: Schema.Number, errors: Schema.Array(ParseError) },
  /** A newer build was requested before this one finished: it was dropped. */
  SupersededGenerate: { buildId: Schema.Number },
  /** The plate shows a build whose geometry this page never made: the Model
   *  was restored (Foldkit's dev reload keeps it across page loads) but the
   *  geometry lives outside the Model. Grow it again. */
  MissedGeometry: { buildId: Schema.Number },

  // Playback.
  ClickedTogglePlay: {},
  ClickedReplay: {},
  ScrubbedProgress: { value: Schema.Number },
  SelectedMode: { mode: RevealMode },
  TickedFrame: { deltaTimeMs: Schema.Number },

  // Appearance.
  ClickedToggleTheme: {},
  CompletedTheme: {},
  ClickedToggleMenu: {},
  SelectedRenderStyle: { renderStyle: RenderStyle },
  SelectedSeason: { season: Season },
  SelectedAutomaticSeason: {},

  // Zoom and pan. The canvas reports gestures: MovedCamera at most once a
  // frame while one is under way (left out of DevTools history, like
  // TickedFrame), SettledCamera where it ended.
  MovedCamera: { camera: Camera },
  SettledCamera: { camera: Camera },
  ClickedZoom: { step: ZoomStep },
  PressedZoomKey: { step: ZoomStep },
  PressedPanKey: { step: PanStep },
  DoubleClickedCanvas: {},

  // The print.
  SelectedPrintSize: { size: PrintSize },
  ClickedDownloadPrint: {},
  /** The print worker finished another band of the sheet. */
  PaintedPrintBand: { done: Schema.Number, total: Schema.Number },
  CompletedPrint: {},
  FailedPrint: { reason: Schema.String },

  // Sharing and routing.
  ClickedCopyLink: {},
  CompletedCopyLink: {},
  CompletedReplaceUrl: {},
  CompletedNavigate: {},
  ChangedUrl: { url: Url },
  ClickedLink: { request: UrlRequest },
})
export type Message = typeof Message.Type
