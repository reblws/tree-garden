import { Effect, Option, Schema, Stream } from 'effect'
import { Subscription } from 'foldkit'

import { Message } from './message'
import type { Model } from './model'
import { printBands } from './printProgress'

/** Animation frames, only while playback is running and there is a plant to
 *  show. Foldkit stops the requestAnimationFrame loop when this is false.
 *  The print's progress, a band at a time, only while one is painting. */
export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  frame: Subscription.animationFrameEntry({
    isActive: (model: Model) => model.playback.isPlaying && Option.isSome(model.shown),
    toMessage: deltaTimeMs => Message.TickedFrame({ deltaTimeMs }),
  }),
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
