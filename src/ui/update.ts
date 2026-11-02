import { Option } from 'effect'
import { type Command, Update } from 'foldkit'
import { UrlRequest } from 'foldkit/navigation'
import { modifyFields } from 'foldkit/struct'
import { toString as urlToString } from 'foldkit/url'

import { type LSystemParams, paramsToSearch } from '../params/lsystem'
import { findPreset } from '../params/presets'
import { clampCamera, fitCamera, isFit, stepPan, stepZoom } from '../render/camera'
import { orientationOf } from '../render/sheet'
import { CopyLink, DownloadPrint, Generate, LoadExternal, NavigateInternal, NewSeed, ReplaceUrl } from './command'
import { inscriptionsOf, printFileName } from './inscriptions'
import { Message } from './message'
import type { Model } from './model'

type UpdateReturn = Update.Return<Model, Message>

/** How long a full Grow or Trace animation takes. */
export const PLAYBACK_DURATION_MS = 4000
/** Cap per-frame time so a backgrounded tab doesn't jump to the end. */
const MAX_FRAME_MS = 50

interface RebuildOptions {
  readonly presetId: string
  /** Restart the growth animation and go back to the fitted view (for a
   *  new plant, not a slider nudge). */
  readonly replay: boolean
  /** Write the new params to the URL now. */
  readonly commit: boolean
  /** A live edit (a slider under the finger, a field being typed in),
   *  not yet committed: the sheet keeps its orientation until it is. */
  readonly isEdit: boolean
}

/**
 * Turn the sheet to suit the plant on screen, if now is a quiet moment:
 * no edit under way and the view fitted. Called after anything that can
 * end such a moment (a build landing, an edit committed, the view going
 * back to Fit), so a turn that had to wait happens as soon as it can.
 * The camera is plate-relative; at the fitted view there is nothing for
 * the turn to move.
 */
const settleSheet = (model: Model): Model =>
  model.isEditing || !isFit(model.camera)
    ? model
    : Option.match(model.shown, {
        onNone: () => model,
        onSome: stats => {
          const orientation = orientationOf(stats.aspect)
          return orientation === model.orientation ? model : modifyFields(model, { orientation: () => orientation })
        },
      })

/** Update the camera, then settle the sheet if the view came back to Fit. */
const moveCamera = (model: Model, next: (camera: Model['camera']) => Model['camera']): UpdateReturn => ({
  model: settleSheet(modifyFields(model, { camera: next })),
})

/** Request a new build for `params`. The previous build stays on screen
 *  until the new one completes. */
const rebuild = (model: Model, params: LSystemParams, options: RebuildOptions): UpdateReturn => {
  const buildId = model.latestBuildId + 1
  const commands: Array<Command.Command<Message>> = [Generate({ buildId, params })]
  if (options.commit) {
    commands.push(ReplaceUrl({ search: paramsToSearch(params) }))
  }
  return {
    model: modifyFields(model, {
      params: () => params,
      presetId: () => options.presetId,
      latestBuildId: () => buildId,
      isEditing: () => options.isEdit,
      isLinkCopied: () => false,
      playback: playback =>
        options.replay ? { ...playback, progress: 0, isPlaying: true } : playback,
      // A new plant has new bounds: whatever you were looking at is gone.
      // An edit keeps the camera: it is plate-relative and the plant is
      // refitted, so you keep looking at about the same part of it.
      camera: camera => (options.replay ? fitCamera : camera),
    }),
    commands,
  }
}

/** A live edit of one parameter: regenerate, mark as custom, don't touch the
 *  URL until the edit is committed. */
const edit = (model: Model, change: Partial<LSystemParams>): UpdateReturn =>
  rebuild(model, { ...model.params, ...change }, { presetId: '', replay: false, commit: false, isEdit: true })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SelectedPreset: ({ presetId }) => {
      const preset = findPreset(presetId)
      if (preset === undefined) {
        return { model }
      }
      return rebuild(
        model,
        { ...preset.params, seed: model.params.seed },
        { presetId, replay: true, commit: true, isEdit: false },
      )
    },
    ChangedAxiom: ({ value }) => edit(model, { axiom: value }),
    ChangedRules: ({ value }) => edit(model, { rules: value }),
    ChangedIterations: ({ value }) => edit(model, { iterations: value }),
    ChangedAngle: ({ value }) => edit(model, { angle: value }),
    ChangedJitter: ({ value }) => edit(model, { jitter: value }),
    // The seed doesn't make the params custom: a preset with another seed is
    // still that preset.
    ChangedSeed: ({ value }) =>
      rebuild(model, { ...model.params, seed: value }, { presetId: model.presetId, replay: false, commit: false, isEdit: true }),

    // The edit is over: the sheet may turn to suit the plant now.
    CommittedEdit: () => ({
      model: settleSheet(modifyFields(model, { isEditing: () => false })),
      commands: [ReplaceUrl({ search: paramsToSearch(model.params) })],
    }),

    ClickedNewSeed: () => ({ model, commands: [NewSeed()] }),
    GotNewSeed: ({ seed }) =>
      rebuild(model, { ...model.params, seed }, { presetId: model.presetId, replay: true, commit: true, isEdit: false }),

    CompletedGenerate: ({ stats }) =>
      stats.buildId !== model.latestBuildId
        ? { model }
        : {
            model: settleSheet(
              modifyFields(model, {
                shown: () => Option.some(stats),
                errors: () => [],
              }),
            ),
          },

    FailedGenerate: ({ buildId, errors }) =>
      buildId !== model.latestBuildId
        ? { model }
        : { model: modifyFields(model, { errors: () => errors }) },

    // Only ever an older build than the latest: nothing to do.
    SupersededGenerate: () => ({ model }),

    ClickedTogglePlay: () => ({
      model: modifyFields(model, {
        playback: playback =>
          playback.isPlaying
            ? { ...playback, isPlaying: false }
            : { ...playback, isPlaying: true, progress: playback.progress >= 1 ? 0 : playback.progress },
      }),
    }),

    ClickedReplay: () => ({
      model: modifyFields(model, {
        playback: playback => ({ ...playback, progress: 0, isPlaying: true }),
      }),
    }),

    ScrubbedProgress: ({ value }) => ({
      model: modifyFields(model, {
        playback: playback => ({ ...playback, progress: value, isPlaying: false }),
      }),
    }),

    SelectedMode: ({ mode }) => ({
      model: modifyFields(model, {
        playback: () => ({ mode, progress: 0, isPlaying: true }),
      }),
    }),

    TickedFrame: ({ deltaTimeMs }) => ({
      model: modifyFields(model, {
        playback: playback => {
          const progress = playback.progress + Math.min(deltaTimeMs, MAX_FRAME_MS) / PLAYBACK_DURATION_MS
          return progress >= 1
            ? { ...playback, progress: 1, isPlaying: false }
            : { ...playback, progress }
        },
      }),
    }),

    // Repainting needs no new build, and the playback carries on as it was.
    SelectedRenderStyle: ({ renderStyle }) => ({
      model: modifyFields(model, { renderStyle: () => renderStyle }),
    }),
    SelectedSeason: ({ season }) => ({
      model: modifyFields(model, { season: () => season }),
    }),

    // The canvas has already clamped gestures to the plant; clamping again
    // here keeps the Model sane whatever sends them.
    MovedCamera: ({ camera }) => ({
      model: modifyFields(model, { camera: () => clampCamera(camera) }),
    }),
    // A turn of the sheet that waited for the fitted view happens when
    // the view gets back there.
    SettledCamera: ({ camera }) => moveCamera(model, () => clampCamera(camera)),
    ClickedZoom: ({ step }) => moveCamera(model, camera => stepZoom(camera, step)),
    PressedZoomKey: ({ step }) => moveCamera(model, camera => stepZoom(camera, step)),
    PressedPanKey: ({ step }) => ({
      model: modifyFields(model, { camera: camera => stepPan(camera, step) }),
    }),
    DoubleClickedCanvas: () => moveCamera(model, () => fitCamera),

    SelectedPrintSize: ({ size }) => ({
      model: modifyFields(model, {
        printSize: () => size,
        printStatus: status => (status === 'Failed' ? 'Idle' : status),
      }),
    }),
    // One print at a time, and only of a plant that is on screen.
    ClickedDownloadPrint: () =>
      Option.match(model.shown, {
        onNone: () => ({ model }),
        onSome: stats =>
          model.printStatus === 'Preparing'
            ? { model }
            : {
                model: modifyFields(model, { printStatus: () => 'Preparing' as const }),
                commands: [
                  DownloadPrint({
                    buildId: stats.buildId,
                    size: model.printSize,
                    // From the plant, not the screen: the same link always
                    // prints the same way, even while the screen's turn
                    // waits for an edit or a zoom to end.
                    orientation: orientationOf(stats.aspect),
                    style: model.renderStyle,
                    season: model.season,
                    inscriptions: inscriptionsOf(model, true),
                    fileName: printFileName(model),
                  }),
                ],
              },
      }),
    CompletedPrint: () => ({ model: modifyFields(model, { printStatus: () => 'Idle' as const }) }),
    FailedPrint: () => ({ model: modifyFields(model, { printStatus: () => 'Failed' as const }) }),

    ClickedCopyLink: () => {
      const search = paramsToSearch(model.params)
      return { model, commands: [ReplaceUrl({ search }), CopyLink({ search })] }
    },
    CompletedCopyLink: () => ({ model: modifyFields(model, { isLinkCopied: () => true }) }),
    CompletedReplaceUrl: () => ({ model }),
    CompletedNavigate: () => ({ model }),

    // The app only ever replaces its own URL, so URL changes need no action.
    ChangedUrl: () => ({ model }),
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url: urlToString(url) })] }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
  })
