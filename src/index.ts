import { createSonicJSApp, registerCollections } from '@sonicjs-cms/core'
import type { Bindings, SonicJSConfig } from '@sonicjs-cms/core'

import leadershipRosterCollection from './collections/leadership-roster.collection'
import { type ContactBindings, runContactRetention } from './contact'
import { createCmsRequestHandler } from './request-handler'
import { runSignupRetention } from './signup-store'
import type { SignupBindings } from './signups'

registerCollections([
  leadershipRosterCollection,
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
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    // The two passes are independent D1 batches, so one failing must not be
    // reported as the other failing. Before 0004_signups.sql is applied the
    // signup pass throws on a missing table, and without this isolation that
    // fails the whole nightly invocation even though contact retention
    // committed — a standing red signal that would mask a real
    // contact-retention failure later. Each pass logs under its own event and
    // the invocation still fails once both have run.
    let failure: unknown
    try {
      await runContactRetention(env as ContactBindings)
    } catch (error) {
      failure = error
      console.error(JSON.stringify({ event: 'contact_retention_failed', error: String(error) }))
    }
    try {
      await runSignupRetention(env as SignupBindings)
    } catch (error) {
      failure ??= error
      console.error(JSON.stringify({ event: 'signup_retention_failed', error: String(error) }))
    }
    if (failure) throw failure
  },
}
