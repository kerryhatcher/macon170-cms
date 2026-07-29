import type { Bindings } from '@sonicjs-cms/core'

import { renderLoginPage } from './login-page'

type CmsAppFetch = (request: Request, env: Bindings, ctx: ExecutionContext) => Response | Promise<Response>

const disabledAuthPaths = new Set(['/auth/seed-admin', '/auth/register', '/auth/register/form'])

export function configuredCorsOrigins(env: Bindings): Set<string> {
  const configured = (env as Bindings & { CORS_ORIGINS?: string }).CORS_ORIGINS ?? ''
  return new Set(
    configured
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
}

export function createCmsRequestHandler(appFetch: CmsAppFetch): CmsAppFetch {
  return async (request, env, ctx) => {
    const url = new URL(request.url)
    const { pathname } = url
    if (disabledAuthPaths.has(pathname)) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    if (request.method === 'GET' && pathname === '/auth/login') {
      return new Response(renderLoginPage(url), {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' https://www.macon170.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
          'Content-Type': 'text/html; charset=UTF-8',
          'Referrer-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
        },
      })
    }

    const response = await appFetch(request, env, ctx)
    const origin = request.headers.get('Origin')
    if (origin && configuredCorsOrigins(env).has(origin) && pathname.startsWith('/api/collections/')) {
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', origin)
      headers.append('Vary', 'Origin')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    }

    return response
  }
}
