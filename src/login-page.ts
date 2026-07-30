function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function notice(message: string | null, kind: 'error' | 'message'): string {
  if (!message) return ''

  return `<p class="notice notice--${kind}" id="login-notice" role="${kind === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</p>`
}

export function renderLoginPage(url: URL): string {
  const error = url.searchParams.get('error')
  const message = url.searchParams.get('message')
  const returnTo = url.searchParams.get('returnTo') === '/admin/calendar'
    ? '/admin/calendar'
    : '/admin/dashboard'
  const returnToJson = JSON.stringify(returnTo).replaceAll('<', '\\u003c')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Volunteer sign in | Pack 170</title>
    <style>
      :root { color-scheme: light; --blue: #003f87; --blue-deep: #002b5c; --blue-soft: #dbeaf8; --gold: #fcd116; --paper: #f7f1e3; --page: #fffdf7; --ink: #272b2e; --muted: #59636b; --rule: #d7cdb8; --red: #a33c34; --green: #28543f; --display: Montserrat, Arial, sans-serif; --body: "Source Sans 3", "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { align-items: stretch; background: linear-gradient(rgba(0, 63, 135, .035) 1px, transparent 1px) 0 1.25rem / 100% 1.75rem, var(--paper); color: var(--ink); display: grid; font: 1.0625rem/1.5 var(--body); margin: 0; min-block-size: 100vh; }
      .shell { display: grid; grid-template-columns: minmax(0, 1.07fr) minmax(22rem, .93fr); min-block-size: 100vh; }
      .welcome { background: var(--blue-deep); color: white; display: grid; min-block-size: 100%; padding: clamp(2rem, 6vw, 5.5rem); position: relative; }
      .welcome::after { background: var(--gold); block-size: 6px; content: ""; inline-size: min(12rem, 42%); inset-block-end: clamp(2rem, 6vw, 5.5rem); inset-inline-start: clamp(2rem, 6vw, 5.5rem); position: absolute; }
      .welcome__inner { align-self: center; max-inline-size: 34rem; }
      .mark { align-items: center; color: white; display: inline-flex; font: 800 .9rem/1 var(--display); gap: .8rem; letter-spacing: -.02em; text-decoration: none; }
      .mark img { block-size: 3.4rem; border-radius: 50%; inline-size: 3.4rem; object-fit: cover; }
      .eyebrow { color: var(--gold); font: 800 .75rem/1.2 var(--display); letter-spacing: .12em; margin: clamp(4rem, 13vh, 8rem) 0 1rem; text-transform: uppercase; }
      h1 { font: 800 clamp(2.8rem, 5.5vw, 5.2rem)/.98 var(--display); letter-spacing: -.055em; margin: 0; max-inline-size: 8ch; }
      .welcome p:last-child { color: var(--blue-soft); font-size: clamp(1.1rem, 1.9vw, 1.35rem); margin: 1.5rem 0 0; max-inline-size: 31rem; }
      .signin { align-items: center; display: grid; padding: clamp(2rem, 7vw, 7rem); }
      .signin__inner { margin-inline: auto; max-inline-size: 26rem; inline-size: 100%; }
      .signin h2 { font: 800 clamp(2rem, 3vw, 2.8rem)/1 var(--display); letter-spacing: -.045em; margin: 0; }
      .signin__intro { color: var(--muted); margin: .8rem 0 2rem; }
      .notice { border-inline-start: 4px solid; margin: 0 0 1.25rem; padding: .8rem 1rem; }
      .notice--error { background: #fbe9e7; border-color: var(--red); color: #6f251f; }
      .notice--message { background: #e6f4ea; border-color: var(--green); color: #1d4b37; }
      form { display: grid; gap: 1.25rem; }
      label { display: grid; font: 800 .92rem/1.2 var(--display); gap: .55rem; }
      input { background: var(--page); border: 1px solid var(--rule); border-radius: 6px 12px 8px 6px; color: var(--ink); font: inherit; min-block-size: 3.25rem; padding: .65rem .8rem; }
      input:focus-visible, button:focus-visible, a:focus-visible { box-shadow: 0 0 0 4px var(--gold); outline: 3px solid var(--blue-deep); outline-offset: 1px; }
      button { background: var(--blue); border: 0; border-radius: 6px 12px 8px 6px; color: white; cursor: pointer; font: 800 1rem/1 var(--display); min-block-size: 3.35rem; padding: .85rem 1rem; text-align: center; }
      button:hover { background: var(--blue-deep); }
      button:disabled { cursor: progress; opacity: .7; }
      .help { color: var(--muted); font-size: .96rem; margin: 1.75rem 0 0; }
      .help a { color: var(--blue); font-weight: 700; text-underline-offset: .18em; }
      @media (max-width: 780px) { .shell { grid-template-columns: 1fr; } .welcome { min-block-size: auto; padding-block: 2rem 3rem; } .welcome::after { inset-block-end: 1.25rem; } .eyebrow { margin-block-start: 3.5rem; } h1 { font-size: clamp(2.8rem, 13vw, 4.4rem); } .signin { padding-block: 3rem 4rem; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="welcome" aria-labelledby="welcome-heading">
        <div class="welcome__inner">
          <a class="mark" href="https://www.macon170.com" aria-label="Pack 170 public website">
            <img src="https://www.macon170.com/logo/pack170-logo-256.webp" alt="">
            <span>Pack 170</span>
          </a>
          <p class="eyebrow">Volunteer workspace</p>
          <h1 id="welcome-heading">Keep the pack moving forward.</h1>
          <p>Sign in to update the information families count on.</p>
        </div>
      </section>
      <section class="signin" aria-labelledby="signin-heading">
        <div class="signin__inner">
          <h2 id="signin-heading">Welcome back</h2>
          <p class="signin__intro">Use your Pack 170 CMS account to continue.</p>
          <div id="login-feedback">${notice(error, 'error') || notice(message, 'message')}</div>
          <form id="login-form" action="/auth/login/form" method="post">
            <label for="email">Email address<input id="email" name="email" type="email" autocomplete="email" required></label>
            <label for="password">Password<input id="password" name="password" type="password" autocomplete="current-password" required></label>
            <button type="submit">Sign in</button>
          </form>
          <p class="help">Need access? <a href="https://www.macon170.com/contact/">Contact Pack 170</a>.</p>
        </div>
      </section>
    </main>
    <script>
      const form = document.querySelector('#login-form');
      const feedback = document.querySelector('#login-feedback');
      const button = form.querySelector('button');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        button.textContent = 'Signing in…';
        feedback.replaceChildren();
        try {
          const response = await fetch(form.action, { method: 'POST', body: new FormData(form), credentials: 'same-origin' });
          const responseHtml = await response.text();
          const message = new DOMParser().parseFromString(responseHtml, 'text/html').body.textContent.trim();
          if (message.includes('Login successful')) {
            window.location.assign(${returnToJson});
            return;
          }
          const notice = document.createElement('p');
          notice.className = 'notice notice--error';
          notice.setAttribute('role', 'alert');
          notice.textContent = message || 'Unable to sign in. Please try again.';
          feedback.append(notice);
        } catch {
          const notice = document.createElement('p');
          notice.className = 'notice notice--error';
          notice.setAttribute('role', 'alert');
          notice.textContent = 'Unable to sign in. Check your connection and try again.';
          feedback.append(notice);
        } finally {
          button.disabled = false;
          button.textContent = 'Sign in';
        }
      });
    </script>
  </body>
</html>`
}
