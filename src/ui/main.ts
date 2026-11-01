import { Option } from 'effect'
import type { Runtime } from 'foldkit'
import type { Url } from 'foldkit/url'

import { type LSystemParams, hasParams, paramsFromSearch } from '../params/lsystem'
import { defaultPreset, presets } from '../params/presets'
import { fitCamera } from '../render/camera'
import { Generate } from './command'
import { Message } from './message'
import { Model } from './model'
import { subscriptions } from './subscription'
import { update } from './update'
import { view } from './view'

const DEFAULT_SEED = 'oak'

const defaultParams: LSystemParams = { ...defaultPreset.params, seed: DEFAULT_SEED }

/** The preset whose params match exactly (ignoring the seed), if any. */
const matchingPresetId = (params: LSystemParams): string =>
  presets.find(({ params: p }) =>
    p.axiom === params.axiom &&
    p.rules === params.rules &&
    p.iterations === params.iterations &&
    p.angle === params.angle &&
    p.jitter === params.jitter,
  )?.id ?? ''

/** Start from the shared link's params if there are any, else the default
 *  preset, and kick off the first build. */
export const init: Runtime.RoutingApplicationInit<Model, Message> = (url: Url) => {
  const search = Option.getOrElse(url.search, () => '')
  const params = hasParams(search) ? paramsFromSearch(search, defaultParams) : defaultParams
  const buildId = 1
  return {
    model: {
      params,
      presetId: matchingPresetId(params),
      latestBuildId: buildId,
      shown: Option.none(),
      errors: [],
      playback: { mode: 'Grow', progress: 0, isPlaying: true },
      renderStyle: 'Leaf',
      season: 'Summer',
      camera: fitCamera,
      isLinkCopied: false,
      printSize: 'A3',
      printStatus: 'Idle',
    },
    commands: [Generate({ buildId, params })],
  }
}

export { Message, Model, subscriptions, update, view }
