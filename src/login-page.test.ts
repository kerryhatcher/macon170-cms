import { describe, expect, it } from 'vitest'

import { renderLoginPage } from './login-page'

describe('renderLoginPage', () => {
  it.each(['/dash', '/admin/calendar', '/admin/contact-form', '/admin/leadership', '/admin/broadcasts', '/admin/broadcasts/lists/266a457f-7e3c-45fd-8f3d-aea88fe6b840'])(
    'preserves the allowlisted %s return path',
    (returnTo) => {
      const page = renderLoginPage(new URL(`https://cms.macon170.com/auth/login?returnTo=${encodeURIComponent(returnTo)}`))

      expect(page).toContain(`window.location.assign("${returnTo}")`)
    },
  )

  it.each(['https://attacker.example', '//attacker.example', '/admin/broadcasts/lists/../other', '/admin/broadcasts/lists/id?redirect=https://attacker.example', '/admin/broadcasts/lists/id%2Fother'])('rejects the untrusted return path %s', (returnTo) => {
    const page = renderLoginPage(new URL('https://cms.macon170.com/auth/login?returnTo=' + encodeURIComponent(returnTo)))

    expect(page).toContain('window.location.assign("/dash")')
    expect(page).not.toContain('attacker.example")')
  })
})
