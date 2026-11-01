import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { describe, expect, test } from 'vitest'

import { defaultPreset, presets } from '../params/presets'
import { type Camera, MAX_ZOOM, fitCamera } from '../render/camera'
import { paramsToSearch } from '../params/lsystem'
import { CopyLink, DownloadPrint, Generate, ReplaceUrl } from './command'
import { Message } from './message'
import type { BuildStats, Model } from './model'
import { PLAYBACK_DURATION_MS, update } from './update'

const initialModel: Model = {
  params: { ...defaultPreset.params, seed: 'oak' },
  presetId: defaultPreset.id,
  latestBuildId: 1,
  shown: Option.none(),
  errors: [],
  playback: { mode: 'Grow', progress: 1, isPlaying: false },
  renderStyle: 'Ink',
  season: 'Summer',
  camera: fitCamera,
  isLinkCopied: false,
  printSize: 'A3',
  printStatus: 'Idle',
}

const zoomed: Camera = { zoom: 4, x: 0.3, y: 0.6 }

const stats = (buildId: number): BuildStats => ({
  buildId,
  symbolCount: 100,
  segmentCount: 40,
  iterationsApplied: 5,
  truncated: false,
  preview: 'F[+F]',
  elapsedMs: 1,
})

describe('update', () => {
  test('dragging a slider regenerates without touching the URL; releasing writes it', () => {
    story(
      update,
      given(initialModel),
      message(Message.ChangedAngle({ value: 30 })),
      model(model => {
        expect(model.params.angle).toBe(30)
        expect(model.presetId).toBe('')
        expect(model.latestBuildId).toBe(2)
      }),
      Command.expectExact(Generate),
      Command.resolve(Generate, Message.CompletedGenerate({ stats: stats(2) })),
      message(Message.CommittedEdit()),
      Command.expectExact(ReplaceUrl),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })

  test('a stale build result is dropped', () => {
    story(
      update,
      given(modifyFields(initialModel, { latestBuildId: () => 3 })),
      message(Message.CompletedGenerate({ stats: stats(2) })),
      model(model => expect(Option.isNone(model.shown)).toBe(true)),
      message(Message.CompletedGenerate({ stats: stats(3) })),
      model(model => expect(Option.getOrThrow(model.shown).buildId).toBe(3)),
    )
  })

  test('a parse error keeps the last good plant on screen', () => {
    story(
      update,
      given(modifyFields(initialModel, { shown: () => Option.some(stats(1)) })),
      message(Message.ChangedRules({ value: 'oops' })),
      Command.resolve(Generate, Message.FailedGenerate({ buildId: 2, errors: [{ line: 1, message: 'bad' }] })),
      model(model => {
        expect(model.errors).toHaveLength(1)
        expect(Option.getOrThrow(model.shown).buildId).toBe(1)
      }),
    )
  })

  test('selecting a preset keeps the seed, replays growth and commits the URL', () => {
    const preset = presets[0]
    if (preset === undefined) throw new Error('no presets')
    story(
      update,
      given(initialModel),
      message(Message.SelectedPreset({ presetId: preset.id })),
      model(model => {
        expect(model.params).toEqual({ ...preset.params, seed: 'oak' })
        expect(model.playback).toMatchObject({ progress: 0, isPlaying: true })
      }),
      Command.resolveAll(
        [Generate, Message.CompletedGenerate({ stats: stats(2) })],
        [ReplaceUrl, Message.CompletedReplaceUrl()],
      ),
    )
  })

  test('switching between ink and line repaints without rebuilding or restarting playback', () => {
    const playing = { mode: 'Trace', progress: 0.4, isPlaying: true } as const
    story(
      update,
      given(modifyFields(initialModel, { playback: () => playing })),
      message(Message.SelectedRenderStyle({ renderStyle: 'Line' })),
      model(model => {
        expect(model.renderStyle).toBe('Line')
        expect(model.latestBuildId).toBe(initialModel.latestBuildId)
        expect(model.playback).toEqual(playing)
      }),
      Command.expectNone(),
      message(Message.SelectedRenderStyle({ renderStyle: 'Ink' })),
      model(model => expect(model.renderStyle).toBe('Ink')),
    )
  })

  test('playback advances with frames and stops at the end', () => {
    story(
      update,
      given(modifyFields(initialModel, { playback: () => ({ mode: 'Grow', progress: 0.99, isPlaying: true }) })),
      message(Message.TickedFrame({ deltaTimeMs: 16 })),
      model(model => expect(model.playback.progress).toBeCloseTo(0.99 + 16 / PLAYBACK_DURATION_MS)),
      message(Message.TickedFrame({ deltaTimeMs: 1000 })),
      model(model => expect(model.playback).toMatchObject({ progress: 1, isPlaying: false })),
    )
  })

  test('the zoom buttons step by octaves about the centre, and Fit goes back', () => {
    story(
      update,
      given(initialModel),
      message(Message.ClickedZoom({ step: 'In' })),
      model(model => expect(model.camera).toEqual({ zoom: 2, x: 0.5, y: 0.5 })),
      Command.expectNone(),
      message(Message.ClickedZoom({ step: 'In' })),
      model(model => expect(model.camera.zoom).toBe(4)),
      message(Message.ClickedZoom({ step: 'Out' })),
      model(model => expect(model.camera.zoom).toBe(2)),
      message(Message.ClickedZoom({ step: 'Fit' })),
      model(model => expect(model.camera).toEqual(fitCamera)),
    )
  })

  test('zooming stops at the ends of the range', () => {
    story(
      update,
      given(modifyFields(initialModel, { camera: () => ({ zoom: MAX_ZOOM, x: 0.5, y: 0.5 }) })),
      message(Message.PressedZoomKey({ step: 'In' })),
      model(model => expect(model.camera.zoom).toBe(MAX_ZOOM)),
      message(Message.PressedZoomKey({ step: 'Fit' })),
      message(Message.PressedZoomKey({ step: 'Out' })),
      model(model => expect(model.camera).toEqual(fitCamera)),
    )
  })

  test('a gesture moves the camera and settles where it ended, kept on the sheet', () => {
    story(
      update,
      given(initialModel),
      message(Message.MovedCamera({ camera: { zoom: 2, x: 0.4, y: 0.5 } })),
      model(model => expect(model.camera).toEqual({ zoom: 2, x: 0.4, y: 0.5 })),
      // Dragged past the edge of the sheet: the view stops at the edge.
      message(Message.SettledCamera({ camera: { zoom: 2, x: -1, y: 0.9 } })),
      model(model => expect(model.camera).toEqual({ zoom: 2, x: 0.25, y: 0.75 })),
      Command.expectNone(),
    )
  })

  test('arrow keys pan the zoomed view; a double-click fits it', () => {
    story(
      update,
      given(modifyFields(initialModel, { camera: () => zoomed })),
      message(Message.PressedPanKey({ step: 'Right' })),
      model(model => {
        expect(model.camera.zoom).toBe(4)
        expect(model.camera.x).toBeCloseTo(0.35)
        expect(model.camera.y).toBe(0.6)
      }),
      message(Message.DoubleClickedCanvas()),
      model(model => expect(model.camera).toEqual(fitCamera)),
    )
  })

  test('a new plant goes back to the fitted view; a slider nudge keeps the camera', () => {
    const preset = presets[1]
    if (preset === undefined) throw new Error('no presets')
    story(
      update,
      given(modifyFields(initialModel, { camera: () => zoomed })),
      message(Message.ChangedAngle({ value: 24 })),
      model(model => expect(model.camera).toEqual(zoomed)),
      Command.resolve(Generate, Message.CompletedGenerate({ stats: stats(2) })),
      message(Message.GotNewSeed({ seed: 'elm-1234' })),
      model(model => expect(model.camera).toEqual(fitCamera)),
      Command.resolveAll(
        [Generate, Message.CompletedGenerate({ stats: stats(3) })],
        [ReplaceUrl, Message.CompletedReplaceUrl()],
      ),
      message(Message.MovedCamera({ camera: zoomed })),
      message(Message.SelectedPreset({ presetId: preset.id })),
      model(model => expect(model.camera).toEqual(fitCamera)),
      Command.resolveAll(
        [Generate, Message.CompletedGenerate({ stats: stats(4) })],
        [ReplaceUrl, Message.CompletedReplaceUrl()],
      ),
    )
  })

  test('the camera is not part of the link', () => {
    story(
      update,
      given(modifyFields(initialModel, { camera: () => zoomed })),
      message(Message.ClickedCopyLink()),
      Command.expectHas(ReplaceUrl({ search: paramsToSearch(initialModel.params) })),
      Command.resolveAll(
        [ReplaceUrl, Message.CompletedReplaceUrl()],
        [CopyLink, Message.CompletedCopyLink()],
      ),
    )
  })

  test('the season repaints the leaves without rebuilding or touching the link', () => {
    story(
      update,
      given(modifyFields(initialModel, { renderStyle: () => 'Leaf' as const })),
      message(Message.SelectedSeason({ season: 'Autumn' })),
      model(model => {
        expect(model.season).toBe('Autumn')
        expect(model.latestBuildId).toBe(initialModel.latestBuildId)
      }),
      Command.expectNone(),
    )
  })

  test('downloading a print paints the shown plant once, at the chosen size, with its inscriptions', () => {
    const shown = modifyFields(initialModel, {
      shown: () => Option.some(stats(1)),
      renderStyle: () => 'Blossom' as const,
    })
    story(
      update,
      given(shown),
      message(Message.SelectedPrintSize({ size: 'A2' })),
      message(Message.ClickedDownloadPrint()),
      model(model => expect(model.printStatus).toBe('Preparing')),
      Command.expectExact(
        DownloadPrint({
          buildId: 1,
          size: 'A2',
          style: 'Blossom',
          season: 'Summer',
          inscriptions: ['ABOP fig. 1.24f', 'Fractal plant', 'n 5 · δ 22.5° · oak'],
          fileName: 'tree-garden-fractal-plant-oak-blossom-a2.png',
        }),
      ),
      Command.resolve(DownloadPrint, Message.CompletedPrint()),
      model(model => expect(model.printStatus).toBe('Idle')),
    )
  })

  test('one print at a time: a click while it paints does nothing', () => {
    story(
      update,
      given(modifyFields(initialModel, { shown: () => Option.some(stats(1)), printStatus: () => 'Preparing' as const })),
      message(Message.ClickedDownloadPrint()),
      model(model => expect(model.printStatus).toBe('Preparing')),
      Command.expectNone(),
    )
  })

  test('a failed print says so, and choosing another size clears it', () => {
    story(
      update,
      given(modifyFields(initialModel, { shown: () => Option.some(stats(1)) })),
      message(Message.ClickedDownloadPrint()),
      Command.resolve(DownloadPrint, Message.FailedPrint({ reason: 'canvas too large' })),
      model(model => expect(model.printStatus).toBe('Failed')),
      message(Message.SelectedPrintSize({ size: 'A4' })),
      model(model => expect(model).toMatchObject({ printSize: 'A4', printStatus: 'Idle' })),
    )
  })

  test('there is nothing to print before the first plant has grown', () => {
    story(
      update,
      given(initialModel),
      message(Message.ClickedDownloadPrint()),
      model(model => expect(model.printStatus).toBe('Idle')),
      Command.expectNone(),
    )
  })
})
