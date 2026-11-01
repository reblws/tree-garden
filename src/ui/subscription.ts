import { Option } from 'effect'
import { Subscription } from 'foldkit'

import { Message } from './message'
import type { Model } from './model'

/** Animation frames, only while playback is running and there is a plant to
 *  show. Foldkit stops the requestAnimationFrame loop when this is false. */
export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  frame: Subscription.animationFrameEntry({
    isActive: (model: Model) => model.playback.isPlaying && Option.isSome(model.shown),
    toMessage: deltaTimeMs => Message.TickedFrame({ deltaTimeMs }),
  }),
}))
