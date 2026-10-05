import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Bindings } from '@sonicjs-cms/core'
import { AuthManager } from '@sonicjs-cms/core/middleware'
import { adminUsersRoutes, authRoutes } from '@sonicjs-cms/core/routes'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCmsRequestHandler } from './request-handler'

// Exercise the installed SonicJS routes against its real schema. A mocked
// appFetch response cannot detect missing required columns in its INSERT.
const coreDir = dirname(createRequire(import.meta.url).resolve('@sonicjs-cms/core/package.json'))
const secret = 'invitation-integration-test-secret'
let sqlite: DatabaseSync
let env: Bindings
let authToken: string
const send = vi.fn().mockResolvedValue({ messageId: 'test-message' })
const app = new Hono<{ Bindings: Bindings }>()
app.route('/admin', adminUsersRoutes)
app.route('/auth', authRoutes)
const handle = createCmsRequestHandler(app.fetch.bind(app))
const ctx = {} as ExecutionContext

function dbAdapter() {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql)
      let values: SQLInputValue[] = []
      return {
        bind(...params: SQLInputValue[]) { values = params; return this },
        async first() { return statement.get(...values) ?? null },
        async run() { return { success: true, meta: statement.run(...values) } },
      }
    },
  }
}

async function invite(email = 'volunteer@example.test', token = authToken) {
  const body = new FormData()
  body.set('first_name', 'Taylor')
  body.set('last_name', 'Volunteer')
  body.set('email', email)
  body.set('role', 'editor')
  return handle(new Request('https://cms.example/admin/invite-user', {
    method: 'POST',
    headers: { Origin: 'https://cms.example', Authorization: `Bearer ${token}` },
    body,
  }), env, ctx)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  for (const file of ['001_initial_schema.sql', '004_stage6_user_management.sql']) {
    sqlite.exec(readFileSync(join(coreDir, 'migrations', file), 'utf8'))
  }
  sqlite.exec("INSERT INTO users (id, email, username, first_name, last_name, role, created_at, updated_at) VALUES ('admin-1', 'admin@example.test', 'admin', 'Admin', 'Volunteer', 'admin', 0, 0)")
  send.mockClear()
  env = {
    DB: dbAdapter(), JWT_SECRET: secret, JWT_EXPIRES_IN: '1h',
    EMAIL: { send }, INVITE_FROM_EMAIL: 'volunteers@example.test',
  } as unknown as Bindings
  authToken = await AuthManager.generateToken('admin-1', 'admin@example.test', 'admin', secret)
})
afterEach(() => sqlite.close())

describe('SonicJS invitation schema compatibility', () => {
  it('creates distinct pending users and emails setup links without exposing tokens', async () => {
    for (const email of ['first@example.test', 'second@example.test']) {
      const response = await invite(email)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ success: true })
    }
    const rows = sqlite.prepare('SELECT username, is_active, password_hash, role, invitation_token FROM users WHERE id != ?').all('admin-1')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.username).not.toBe(rows[1]!.username)
    for (const row of rows) {
      expect(row.username).toEqual(expect.any(String))
      expect(row).toMatchObject({ is_active: 0, password_hash: null, role: 'editor' })
      expect(row.invitation_token).toEqual(expect.any(String))
    }
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]![0].text).toContain('/auth/accept-invitation?token=')
  })

  it('lets the recipient choose a username and password and consumes the token', async () => {
    expect((await invite()).status).toBe(200)
    const pending = sqlite.prepare('SELECT id, invitation_token FROM users WHERE email = ?').get('volunteer@example.test')!
    const fields = { token: String(pending.invitation_token), username: 'taylor', password: 'test-only-password-42', confirm_password: 'test-only-password-42' }
    const accept = () => handle(new Request('https://cms.example/auth/accept-invitation', {
      method: 'POST', body: new URLSearchParams(fields),
    }), env, ctx)
    const response = await accept()
    expect(response.status).toBe(302)
    const user = sqlite.prepare('SELECT username, password_hash, is_active, invitation_token FROM users WHERE id = ?').get(String(pending.id))!
    expect(user).toMatchObject({ username: 'taylor', is_active: 1, invitation_token: null })
    expect(await AuthManager.verifyPassword(fields.password, String(user.password_hash))).toBe(true)
    expect((await accept()).status).toBe(400)
  })

  it('rejects duplicate emails without sending a second message', async () => {
    expect((await invite()).status).toBe(200)
    expect((await invite()).status).toBe(400)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rejects non-administrators before creating or emailing an invitation', async () => {
    const viewer = await AuthManager.generateToken('viewer-1', 'viewer@example.test', 'viewer', secret)
    expect((await invite('volunteer@example.test', viewer)).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT count(*) AS count FROM users').get()!.count).toBe(1)
  })
})
