import type { Bindings } from '@sonicjs-cms/core'
import { describe, expect, it, vi } from 'vitest'

import { configuredCorsOrigins, createCmsRequestHandler } from '../src/request-handler'

const executionContext = {} as ExecutionContext
const cmsEnv = (origins?: string) => ({ CORS_ORIGINS: origins } as Bindings)

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
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
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
})
