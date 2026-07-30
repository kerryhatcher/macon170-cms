import { describe, expect, it } from 'vitest'

import { renderCalendarAdminPage } from './calendar-admin-page'

describe('renderCalendarAdminPage', () => {
  it('emits the shared header behavior inside a runnable script', () => {
    const page = renderCalendarAdminPage('test-csrf-token')
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      ([, script]) => script,
    )

    expect(scripts.some((script) => script.includes('admin-header__toggle'))).toBe(true)
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow()
    }
  })
})
