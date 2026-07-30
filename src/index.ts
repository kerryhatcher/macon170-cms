import { createSonicJSApp, registerCollections } from '@sonicjs-cms/core'
import type { Bindings, SonicJSConfig } from '@sonicjs-cms/core'

import leadershipRosterCollection from './collections/leadership-roster.collection'
import calendarEventCollection from './collections/calendar-event.collection'
import { createCmsRequestHandler } from './request-handler'

registerCollections([
  leadershipRosterCollection,
  calendarEventCollection,
])

const config: SonicJSConfig = {
  collections: {
    autoSync: true,
  },
  plugins: {
    directory: './src/plugins',
    autoLoad: false,
  },
  adminAccessRoles: ['admin'],
  name: 'Pack 170 CMS',
}

const app = createSonicJSApp(config)
const handleRequest = createCmsRequestHandler(app.fetch.bind(app))

/**
 * Keep SonicJS's development account bootstrap and public registration routes
 * outside the application entirely. This check deliberately runs before the
 * framework so those endpoints cannot mutate the CMS database.
 */
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx)
  },
}
