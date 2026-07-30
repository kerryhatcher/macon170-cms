import type { Bindings } from '@sonicjs-cms/core'
import { AuthManager } from '@sonicjs-cms/core/middleware'
import { describe, expect, it, vi } from 'vitest'

import { configuredCorsOrigins, createCmsRequestHandler } from '../src/request-handler'

const executionContext = {} as ExecutionContext
const cmsEnv = (origins?: string, db?: unknown) => ({
  CORS_ORIGINS: origins,
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
})
