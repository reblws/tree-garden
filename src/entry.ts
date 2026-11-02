import { Runtime } from 'foldkit'

import { startLSystemWorker } from './engine/lsystem'
import { Message, Model, init, subscriptions, update, view } from './ui/main'

// The generator's worker starts loading now, alongside the app, so it is
// ready by the first build.
startLSystemWorker()

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  routing: {
    onUrlRequest: request => Message.ClickedLink({ request }),
    onUrlChange: url => Message.ChangedUrl({ url }),
  },
  container: document.getElementById('root'),
  devTools: {
    Message,
    excludeFromHistory: ['TickedFrame', 'MovedCamera'],
  },
})

Runtime.run(application)
