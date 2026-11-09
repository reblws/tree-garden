import { Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { Message } from './message'
import type { Model } from './model'
import { GeometryStore } from '../engine/geometryStore'
import { printBands } from './printProgress'

/** Animation frames, only while playback is running and there is a plant to
 *  show. Foldkit stops the requestAnimationFrame loop when this is false.
 *  The print's progress, a band at a time, only while one is painting.
 *  And a check that the build on the plate has its geometry in this page:
 *  a restored Model (Foldkit's dev reload) points at a build this page never
 *  grew, which would leave a blank plate. */
export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  frame: Subscription.animationFrameEntry({
    isActive: (model: Model) => model.playback.isPlaying && Option.isSome(model.shown),
    toMessage: deltaTimeMs => Message.TickedFrame({ deltaTimeMs }),
  }),
  missingGeometry: entry(
    { shownBuildId: Schema.Number, isLatest: Schema.Boolean },
    {
      modelToDependencies: model => {
        const shownBuildId = Option.match(model.shown, { onNone: () => -1, onSome: stats => stats.buildId })
        return { shownBuildId, isLatest: shownBuildId === model.latestBuildId }
      },
      dependenciesToStream: ({ shownBuildId, isLatest }) =>
        isLatest && shownBuildId >= 0 && GeometryStore.get(shownBuildId) === undefined
          ? Stream.make(Message.MissedGeometry({ buildId: shownBuildId }))
          : Stream.empty,
    },
  ),
  printProgress: entry(
    { isPrinting: Schema.Boolean },
    {
      modelToDependencies: model => ({ isPrinting: model.printStatus === 'Preparing' }),
      dependenciesToStream: ({ isPrinting }) =>
        Stream.when(
          printBands.pipe(Stream.map(({ done, total }) => Message.PaintedPrintBand({ done, total }))),
          Effect.sync(() => isPrinting),
        ),
    },
  ),
}))
