import { Effect, Random, Schema } from 'effect'
import { Command } from 'foldkit'
import { load, pushUrl, replaceUrl } from 'foldkit/navigation'

import { GeometryStore } from '../engine/geometryStore'
import { generateLSystem } from '../engine/lsystem'
import { LSystemParams } from '../params/lsystem'
import { PrintSize, downloadPrint } from '../render/print'
import { RenderStyle } from '../render/renderStyle'
import { Season } from '../render/season'
import { Message } from './message'

/** Grow the plant for `params`, put the geometry in the store under
 *  `buildId`, and report the stats back to update. */
export const Generate = Command.define('Generate', {
  args: { buildId: Schema.Number, params: LSystemParams },
  messages: [Message.CompletedGenerate, Message.FailedGenerate],
  execute: ({ buildId, params }) =>
    Effect.gen(function* () {
      const startedAt = performance.now()
      const result = yield* generateLSystem(params)
      if (!result.ok) {
        return Message.FailedGenerate({ buildId, errors: result.errors })
      }
      GeometryStore.set(buildId, result.geometry)
      return Message.CompletedGenerate({
        stats: {
          buildId,
          symbolCount: result.symbolCount,
          segmentCount: result.geometry.count,
          iterationsApplied: result.iterationsApplied,
          truncated: result.truncated,
          preview: result.preview,
          elapsedMs: performance.now() - startedAt,
        },
      })
    }),
})

const SEED_WORDS = ['oak', 'ash', 'elm', 'yew', 'fir', 'birch', 'alder', 'aspen', 'cedar', 'larch', 'maple', 'rowan', 'willow', 'hazel', 'linden']

/** A fresh, readable seed such as "rowan-4821". Uses Effect's default
 *  (unseeded) Random service, which tests can replace. */
export const NewSeed = Command.define('NewSeed', {
  messages: [Message.GotNewSeed],
  execute: Effect.gen(function* () {
    const index = yield* Random.nextIntBetween(0, SEED_WORDS.length - 1)
    const word = SEED_WORDS[index] ?? 'oak'
    const number = yield* Random.nextIntBetween(1000, 9999)
    return Message.GotNewSeed({ seed: `${word}-${number}` })
  }),
})

export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { search: Schema.String },
  messages: [Message.CompletedReplaceUrl],
  execute: ({ search }) =>
    replaceUrl(`${window.location.pathname}${search}`).pipe(
      Effect.as(Message.CompletedReplaceUrl()),
    ),
})

/** Copy a share link built from `search`, so it is right even if the
 *  address bar hasn't been updated yet. */
export const CopyLink = Command.define('CopyLink', {
  args: { search: Schema.String },
  messages: [Message.CompletedCopyLink],
  execute: ({ search }) =>
    Effect.promise(() =>
      navigator.clipboard
        .writeText(`${window.location.origin}${window.location.pathname}${search}`)
        .catch(() => undefined),
    ).pipe(Effect.as(Message.CompletedCopyLink())),
})

/**
 * Paint the plate of build `buildId` as a print on a sheet of `size` at
 * 300 dpi, off screen, and hand it to the browser as a download named
 * `fileName`. Takes a second or several; the painting yields between
 * bands, so the page stays responsive meanwhile.
 */
export const DownloadPrint = Command.define('DownloadPrint', {
  args: {
    buildId: Schema.Number,
    size: PrintSize,
    style: RenderStyle,
    season: Season,
    inscriptions: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
    fileName: Schema.String,
  },
  messages: [Message.CompletedPrint, Message.FailedPrint],
  execute: ({ buildId, size, style, season, inscriptions, fileName }) =>
    Effect.tryPromise({
      try: async () => {
        const geometry = GeometryStore.get(buildId)
        if (geometry === undefined) throw new Error('The plant is no longer in memory')
        await downloadPrint({ geometry, style, season, size, inscriptions }, fileName)
      },
      catch: error => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedPrint(),
        onFailure: reason => Message.FailedPrint({ reason }),
      }),
    ),
})

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigate())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedNavigate())),
})
