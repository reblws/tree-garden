import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { type Plugin, type PluginOption, defineConfig } from 'vite'

/**
 * Foldkit's `foldkit:view-identity` transform wraps every function's return
 * value in `brandViewResult` so DevTools can name view nodes. It does this in
 * production builds too, and in modules that never produce views. In the hot
 * loops of the generator and renderer that costs about a third of the
 * generation time and a fifth of the paint time (measured on a 350K-segment
 * tree). So skip the transform for the modules below; views stay branded.
 */
const UNBRANDED = /\/src\/(core|render|engine)\//

const flatten = (option: unknown): Array<Plugin> =>
  Array.isArray(option) ? option.flatMap(flatten) : option ? [option as Plugin] : []

const skipBranding = (plugins: PluginOption): Array<Plugin> =>
  flatten(plugins).map(plugin => {
    if (plugin.name !== 'foldkit:view-identity' || plugin.transform === undefined) {
      return plugin
    }
    const original = plugin.transform
    const handler = typeof original === 'function' ? original : original.handler
    const wrapped: typeof handler = function (this: ThisParameterType<typeof handler>, code, id, options) {
      return UNBRANDED.test(id) ? null : handler.call(this, code, id, options)
    }
    return {
      ...plugin,
      transform: typeof original === 'function' ? wrapped : { ...original, handler: wrapped },
    }
  })

export default defineConfig({
  plugins: [tailwindcss(), skipBranding(foldkit())],
  // The print worker (render/print.worker.ts) is an ES module worker.
  worker: { format: 'es' },
})
