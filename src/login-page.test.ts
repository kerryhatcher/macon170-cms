import { describe, expect, it } from 'vitest'

import { renderLoginPage } from './login-page'

describe('renderLoginPage', () => {
  it.each(['/dash', '/admin/calendar', '/admin/contact-form', '/admin/leadership'])(
    'preserves the allowlisted %s return path',
    (returnTo) => {
      const page = renderLoginPage(new URL(`https://cms.macon170.com/auth/login?returnTo=${encodeURIComponent(returnTo)}`))

      expect(page).toContain(`window.location.assign("${returnTo}")`)
    },
  )

  it('falls back to the dashboard for an untrusted return path', () => {
    const page = renderLoginPage(new URL('https://cms.macon170.com/auth/login?returnTo=https://attacker.example'))

    expect(page).toContain('window.location.assign("/dash")')
    expect(page).not.toContain('attacker.example")')
  })
})
