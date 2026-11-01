import { Runtime } from 'foldkit'

import { Message, Model, init, subscriptions, update, view } from './ui/main'

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
