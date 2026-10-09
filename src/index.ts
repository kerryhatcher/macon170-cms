import { handleMcp } from './mcp'
import { cleanMcpCredentials } from './mcp/oauth'
import type { McpEnv } from './mcp/security'
import { runBroadcastDelivery, type BroadcastBindings } from "./broadcasts"
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
    const mcp = await handleMcp(request, env as McpEnv, async next => handleRequest(next, env, ctx))
    return mcp ?? handleRequest(request, env, ctx)
  },
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    if (controller.cron === "* * * * *") {
      await runBroadcastDelivery(env as BroadcastBindings)
      return
    }
    // Maintenance passes are independent: attempt every pass before reporting
    // a failure, so a broken cleanup cannot prevent the other retention work.
    let failure: unknown
    try {
      await cleanMcpCredentials(env as McpEnv)
    } catch (error) {
      failure = error
      console.error(JSON.stringify({ event: 'mcp_retention_failed' }))
    }
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
