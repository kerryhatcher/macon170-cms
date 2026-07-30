import type { Bindings } from '@sonicjs-cms/core'
import { AuthManager, generateCsrfToken } from '@sonicjs-cms/core/middleware'
import { describe, expect, it, vi } from 'vitest'

import { configuredCorsOrigins, createCmsRequestHandler } from '../src/request-handler'

const executionContext = {} as ExecutionContext
const cmsEnv = (origins?: string, db?: unknown, appVersion = 'test-version') => ({
  APP_VERSION: appVersion,
  CORS_ORIGINS: origins,
  ENVIRONMENT: 'test',
  JWT_SECRET: 'test-secret-that-is-not-used-in-production',
  DB: db,
} as unknown as Bindings)

describe('configuredCorsOrigins', () => {
  it('parses comma-separated origins and ignores whitespace', () => {
    expect(configuredCorsOrigins(cmsEnv(' https://www.macon170.com, http://kudzu:41771, '))).toEqual(
      new Set(['https://www.macon170.com', 'http://kudzu:41771']),
    )
  })
})

describe('CMS request guard', () => {
  it('exposes the deployed version without caching', async () => {
    const handleRequest = createCmsRequestHandler(vi.fn())

    const response = await handleRequest(
      new Request('https://cms.example/api/version'),
      cmsEnv(undefined, undefined, 'abc123'),
      executionContext,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      service: 'macon170-cms',
      version: 'abc123',
      environment: 'test',
    })
  })

  it('supports HEAD requests for the deployed version', async () => {
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.example/api/version', { method: 'HEAD' }),
      cmsEnv(),
      executionContext,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('')
  })

  it.each(['/auth/seed-admin', '/auth/register', '/auth/register/form'])('returns 404 for %s before the CMS app runs', async (pathname) => {
    const appFetch = vi.fn()
    const handleRequest = createCmsRequestHandler(appFetch)

    const response = await handleRequest(new Request(`https://cms.example${pathname}`), cmsEnv(), executionContext)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'Not found.' },
    })
    expect(appFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['GET', '/admin/plugins/turnstile'],
    ['POST', '/admin/plugins/turnstile/activate'],
    ['POST', '/admin/plugins/turnstile/settings'],
  ])('keeps Worker-secret Turnstile outside SonicJS plugin storage: %s %s', async (method, pathname) => {
    const appFetch = vi.fn()
    const response = await createCmsRequestHandler(appFetch)(
      new Request(`https://cms.example${pathname}`, { method }),
      cmsEnv(),
      executionContext,
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'managed_configuration',
        message: 'Turnstile is managed by the Pack contact endpoint.',
      },
    })
    expect(appFetch).not.toHaveBeenCalled()
  })

  it('adds CORS only for configured origins on public collection endpoints', async () => {
    const appFetch = vi.fn().mockResolvedValue(new Response('{"data":[]}', { headers: { Vary: 'Accept-Encoding' } }))
    const handleRequest = createCmsRequestHandler(appFetch)
    const request = new Request('https://cms.example/api/collections/leadership-roster/content', {
      headers: { Origin: 'https://www.macon170.com' },
    })

    const response = await handleRequest(request, cmsEnv('https://www.macon170.com'), executionContext)

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.macon170.com')
    expect(response.headers.get('Vary')).toContain('Origin')
  })

  it('does not add CORS for unconfigured origins', async () => {
    const appFetch = vi.fn().mockResolvedValue(new Response('{}'))
    const handleRequest = createCmsRequestHandler(appFetch)
    const request = new Request('https://cms.example/api/collections/leadership-roster/content', {
      headers: { Origin: 'http://kudzu:41771' },
    })

    const response = await handleRequest(request, cmsEnv('https://www.macon170.com'), executionContext)

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('renders the Pack 170 login page without invoking SonicJS', async () => {
    const appFetch = vi.fn()
    const handleRequest = createCmsRequestHandler(appFetch)

    const response = await handleRequest(
      new Request('https://cms.example/auth/login?error=Invalid%20credentials'),
      cmsEnv(),
      executionContext,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.text()).resolves.toContain('Volunteer workspace')
    expect(appFetch).not.toHaveBeenCalled()
  })

  it('escapes login query messages before rendering them', async () => {
    const handleRequest = createCmsRequestHandler(vi.fn())

    const response = await handleRequest(
      new Request('https://cms.example/auth/login?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E'),
      cmsEnv(),
      executionContext,
    )
    const page = await response.text()

    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).not.toContain('<script>alert(1)</script>')
  })

  it('returns published events with the canonical envelope, CORS, caching, and 304 support', async () => {
    const row = {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 2,
      slug: 'pack-meeting',
      publication_state: 'published',
      event_status: 'scheduled',
      category: 'pack',
      title: 'Pack Meeting',
      summary: 'A monthly gathering for Pack 170 families.',
      description: 'Families gather for activities and announcements.',
      starts_at: '2027-01-12T23:30:00.000Z',
      ends_at: null,
      timezone: 'America/New_York',
      location_name: null,
      address: null,
      audience: 'All Pack 170 families',
      what_to_bring: null,
      cost: null,
      registration_url: null,
      milestone: null,
      created_at: 1_800_000_000_000,
      updated_at: 1_800_000_100_000,
      published_at: 1_800_000_050_000,
    }
    const db = {
      prepare: vi.fn(() => ({
        bind() { return this },
        all: async () => ({ results: [row] }),
      })),
    }
    const handleRequest = createCmsRequestHandler(vi.fn())
    const first = await handleRequest(
      new Request('https://cms.macon170.com/api/calendar/v1/events', {
        headers: { Origin: 'https://www.macon170.com' },
      }),
      cmsEnv('https://www.macon170.com', db),
      executionContext,
    )
    expect(first.status).toBe(200)
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe('https://www.macon170.com')
    const etag = first.headers.get('ETag')
    await expect(first.json()).resolves.toEqual({
      version: 'v1',
      events: [expect.objectContaining({
        id: row.id,
        revision: 2,
        publicationState: 'published',
        eventStatus: 'scheduled',
        startsAt: row.starts_at,
      })],
    })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining(
      "COALESCE(ends_at, starts_at) >= ?",
    ))

    const notModified = await handleRequest(
      new Request('https://cms.macon170.com/api/calendar/v1/events', {
        headers: { 'If-None-Match': etag! },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(notModified.status).toBe(304)
    expect(await notModified.text()).toBe('')

    const weakNotModified = await handleRequest(
      new Request('https://cms.macon170.com/api/calendar/v1/events', {
        headers: { 'If-None-Match': `W/${etag}` },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(weakNotModified.status).toBe(304)
    expect(await weakNotModified.text()).toBe('')
  })

  it('returns 404 for a draft or missing public event', async () => {
    const db = {
      prepare: () => ({
        bind() { return this },
        first: async () => null,
      }),
    }
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/api/calendar/v1/events/draft-event'),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'not_found', message: 'Calendar event not found.' },
    })
  })

  it('renders matching GET and HEAD ICS metadata', async () => {
    const db = {
      prepare: () => ({
        all: async () => ({ results: [] }),
      }),
    }
    const handleRequest = createCmsRequestHandler(vi.fn())
    const get = await handleRequest(
      new Request('https://cms.macon170.com/api/calendar/v1/calendar.ics'),
      cmsEnv(undefined, db),
      executionContext,
    )
    const head = await handleRequest(
      new Request('https://cms.macon170.com/api/calendar/v1/calendar.ics', { method: 'HEAD' }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(get.headers.get('ETag')).toBe(head.headers.get('ETag'))
    expect(get.headers.get('Content-Type')).toBe('text/calendar; charset=UTF-8')
    expect(await get.text()).toContain('BEGIN:VCALENDAR\r\n')
    expect(await head.text()).toBe('')
  })

  it('redirects unauthenticated calendar managers to an allowlisted return path', async () => {
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/admin/calendar'),
      cmsEnv(),
      executionContext,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(
      'https://cms.macon170.com/auth/login?returnTo=%2Fadmin%2Fcalendar',
    )
  })

  it('serves the editor to an active admin and rejects mutations without CSRF', async () => {
    const token = await AuthManager.generateToken(
      'admin-1',
      'admin@example.test',
      'admin',
      'test-secret-that-is-not-used-in-production',
    )
    const db = {
      prepare: () => ({
        bind() { return this },
        first: async () => ({ id: 'admin-1' }),
      }),
    }
    const handleRequest = createCmsRequestHandler(vi.fn())
    const page = await handleRequest(
      new Request('https://cms.macon170.com/admin/calendar', {
        headers: { Cookie: `auth_token=${token}` },
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(page.status).toBe(200)
    expect(page.headers.get('Set-Cookie')).toContain('csrf_token=')
    await expect(page.text()).resolves.toContain('Calendar management')

    const mutation = await handleRequest(
      new Request('https://cms.macon170.com/api/calendar-admin/v1/events', {
        method: 'POST',
        headers: {
          Cookie: `auth_token=${token}`,
          Origin: 'https://cms.macon170.com',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(mutation.status).toBe(403)
    await expect(mutation.json()).resolves.toEqual({
      error: { code: 'invalid_csrf', message: 'Security token rejected.' },
    })

  })

  it('redirects the standalone SonicJS contact renderer to the branded page', async () => {
    const response = await createCmsRequestHandler(vi.fn())(
      new Request('https://cms.macon170.com/forms/contact'),
      cmsEnv(),
      executionContext,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(
      'https://www.macon170.com/contact/',
    )
  })

  it('retains the public contact schema with configured CORS', async () => {
    const appFetch = vi.fn().mockResolvedValue(
      Response.json({
        id: 'default-contact-form',
        settings: { version: 'pack-contact-v1' },
      }),
    )
    const response = await createCmsRequestHandler(appFetch)(
      new Request('https://cms.macon170.com/api/forms/contact/schema', {
        headers: { Origin: 'https://www.macon170.com' },
      }),
      cmsEnv('https://www.macon170.com'),
      executionContext,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://www.macon170.com',
    )
    expect(appFetch).toHaveBeenCalledOnce()
  })

  it('protects the contact queue with CMS admin authentication and CSRF', async () => {
    const handleRequest = createCmsRequestHandler(vi.fn())
    const anonymous = await handleRequest(
      new Request(
        'https://cms.macon170.com/admin/forms/default-contact-form/submissions',
      ),
      cmsEnv(),
      executionContext,
    )
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('Location')).toContain(
      '/auth/login?returnTo=%2Fadmin%2Fforms%2Fdefault-contact-form%2Fsubmissions',
    )

    const adminToken = await AuthManager.generateToken(
      'admin-1',
      'admin@example.test',
      'admin',
      'test-secret-that-is-not-used-in-production',
    )
    const db = {
      prepare: () => ({
        bind() {
          return this
        },
        first: async () => ({ id: 'admin-1' }),
      }),
    }
    const page = await handleRequest(
      new Request(
        'https://cms.macon170.com/admin/forms/default-contact-form/submissions',
        { headers: { Cookie: `auth_token=${adminToken}` } },
      ),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(page.status).toBe(200)
    expect(page.headers.get('Set-Cookie')).toContain('csrf_token=')
    await expect(page.text()).resolves.toContain('Volunteer queue')

    const mutation = await handleRequest(
      new Request(
        'https://cms.macon170.com/api/contact-admin/v1/submissions/11111111-1111-4111-8111-111111111111',
        {
          method: 'PATCH',
          headers: {
            Cookie: `auth_token=${adminToken}`,
            Origin: 'https://cms.macon170.com',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'reviewed' }),
        },
      ),
      cmsEnv(undefined, db),
      executionContext,
    )
    expect(mutation.status).toBe(403)
    await expect(mutation.json()).resolves.toEqual({
      error: { code: 'invalid_csrf', message: 'Security token rejected.' },
    })

    const csrfToken = await generateCsrfToken(
      'test-secret-that-is-not-used-in-production',
    )
    const batches: Array<Array<{ sql: string }>> = []
    const mutationDb = {
      prepare: (sql: string) => ({
        sql,
        bind() {
          return this
        },
        first: async () =>
          sql.includes('FROM users')
            ? { id: 'admin-1' }
            : { status: 'pending', content_id: 'content-1' },
      }),
      batch: async (statements: Array<{ sql: string }>) => {
        batches.push(statements)
        return statements.map(() => ({ success: true }))
      },
    }
    const acceptedMutation = await handleRequest(
      new Request(
        'https://cms.macon170.com/api/contact-admin/v1/submissions/11111111-1111-4111-8111-111111111111',
        {
          method: 'PATCH',
          headers: {
            Cookie: `auth_token=${adminToken}; csrf_token=${csrfToken}`,
            Origin: 'https://cms.macon170.com',
            'X-CSRF-Token': csrfToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ status: 'reviewed' }),
        },
      ),
      cmsEnv(undefined, mutationDb),
      executionContext,
    )
    expect(acceptedMutation.status).toBe(200)
    await expect(acceptedMutation.json()).resolves.toMatchObject({
      status: 'reviewed',
      statusLabel: 'In progress',
    })
    expect(
      batches[0].some(({ sql }) => sql.includes('contact_submission_audit')),
    ).toBe(true)
  })

  it('rejects a non-admin CMS user from the contact queue', async () => {
    const token = await AuthManager.generateToken(
      'editor-1',
      'editor@example.test',
      'editor',
      'test-secret-that-is-not-used-in-production',
    )
    const response = await createCmsRequestHandler(vi.fn())(
      new Request(
        'https://cms.macon170.com/admin/forms/default-contact-form/submissions',
        { headers: { Cookie: `auth_token=${token}` } },
      ),
      cmsEnv(),
      executionContext,
    )

    expect(response.status).toBe(403)
  })
})
