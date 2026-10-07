import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderInvitePage } from './invite-page'

describe('invitation recovery page', () => {
  it('renders the existing recipient and role beside a resend action', () => {
    const page = renderInvitePage('csrf-test', [{
      id: '11111111-1111-4111-8111-111111111111', email: 'taylor@example.test',
      first_name: 'Taylor', last_name: 'Volunteer', role: 'editor',
    }])
    expect(page).toContain('taylor@example.test')
    expect(page).toContain('Taylor Volunteer')
    expect(page).toContain('Editor')
    expect(page).toContain('data-resend-url="/admin/resend-invitation/11111111-1111-4111-8111-111111111111"')
    expect(page).toContain('Resend invitation')
  })

  it('escapes pending-user data instead of allowing HTML injection', () => {
    const page = renderInvitePage('csrf-test', [{
      id: '" onmouseover="alert(1)', email: '<img src=x onerror=alert(1)>',
      first_name: '<script>alert(1)</script>', last_name: '" & Volunteer', role: '<svg onload=alert(1)>',
    }])
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).not.toContain('<svg onload=alert(1)>')
    expect(page).not.toContain('" onmouseover="')
  })

  it('shows a useful empty state when there are no pending invitations', () => {
    const page = renderInvitePage('csrf-test', [])
    expect(page).toContain('No pending invitations')
    expect(page).not.toContain('data-resend-url=')
  })

  it('distinguishes a failed pending-list load from an empty list', () => {
    const page = renderInvitePage('csrf-test', null)
    expect(page).toContain('Pending invitations could not be loaded')
    expect(page).not.toContain('No pending invitations')
    expect(page).toContain('id="invite-form"')
  })
})

// Execute the actual rendered browser script. Only the DOM and external fetch
// boundary are substituted; the click handler, loading guard and notices are real.
function recoveryUi(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  let click: () => Promise<void> = async () => {}
  let notice: { textContent: string; role?: string } | undefined
  const feedback = { replaceChildren(value?: typeof notice) { notice = value } }
  const button = {
    disabled: false, textContent: 'Resend invitation', dataset: { resendUrl: '/admin/resend-invitation/pending-1' },
    addEventListener(_event: string, handler: typeof click) { click = handler },
    closest() { return { querySelector() { return feedback } } },
  }
  const form = { querySelector() { return {} }, addEventListener() {} }
  const document = {
    querySelector(selector: string) { return selector === '#invite-form' ? form : selector === '#feedback' ? feedback : null },
    querySelectorAll() { return [button] }, addEventListener() {},
    createElement() { return { textContent: '', setAttribute(_key: string, value: string) { this.role = value }, role: '' } },
  }
  const script = renderInvitePage('csrf-test').match(/<script>([\s\S]*)<\/script>/)![1]!
  runInNewContext(script, { document, fetch, FormData })
  return { button, click: () => click(), notice: () => notice }
}

describe('rendered resend interaction', () => {
  it('posts the stored endpoint with CSRF and prevents double sends while loading or after success', async () => {
    const requests: Array<{url: string; init: RequestInit}> = []
    let finish!: (response: Response) => void
    const ui = recoveryUi((url, init) => { requests.push({url, init}); return new Promise(resolve => { finish = resolve }) })
    const sending = ui.click()
    expect(ui.button.disabled).toBe(true)
    await ui.click()
    finish(Response.json({success: true, message: 'Invitation email sent.'}))
    await sending
    await ui.click()
    expect(requests).toEqual([{url: '/admin/resend-invitation/pending-1', init: {
      method: 'POST', headers: {'X-CSRF-Token': 'csrf-test'}, credentials: 'same-origin',
    }}])
    expect(ui.notice()).toMatchObject({textContent: 'Invitation email sent.', role: 'status'})
    expect(ui.button.disabled).toBe(true)
  })

  it('announces a structured API error and lets the administrator retry', async () => {
    const ui = recoveryUi(async () => Response.json({error: {code: 'invalid_csrf', message: 'Security token rejected.'}}, {status: 403}))
    await ui.click()
    expect(ui.notice()).toMatchObject({textContent: 'Security token rejected.', role: 'alert'})
    expect(ui.button.disabled).toBe(false)
    expect(ui.button.textContent).toBe('Resend invitation')
  })

  it('warns about uncertain delivery after a network failure instead of claiming it was sent', async () => {
    const ui = recoveryUi(async () => { throw new TypeError('Network unavailable') })
    await ui.click()
    expect(ui.notice()?.textContent).toContain('Unable to confirm delivery')
    expect(ui.notice()?.role).toBe('alert')
    expect(ui.button.disabled).toBe(false)
  })
})
