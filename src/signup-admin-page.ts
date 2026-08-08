import {
  renderAdminHeader,
  renderAdminHeaderScript,
  renderAdminHeaderStyles,
} from "./admin-header";

// Single choke point for every value interpolated into an inline <script>
// in this file. JSON.stringify escapes quotes/backslashes but NOT "<", so a
// value containing the literal text "</script>" can otherwise terminate the
// element early and inject a sibling <script> that runs with the page's
// privileges (and can read the non-HttpOnly CSRF cookie). Route every such
// value through here — present and future — so none can miss the escape.
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

// Shared shell for both signup admin pages, mirroring the doctype/head/style
// structure of calendar-admin-page.ts. Body markup and the page-specific
// module script are supplied by each exported page function; the CSRF token
// and header chrome are wired in once, here.
function renderSignupShell(
  title: string,
  csrfToken: string,
  body: string,
  script: string,
): string {
  const token = scriptSafeJson(csrfToken);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · Pack 170 CMS</title>
<style>
  :root { color-scheme: light; --blue: #003f87; --deep: #002b5c; --gold: #fcd116; --paper: #f7f1e3; --white: #fffdf7; --ink: #272b2e; --muted: #59636b; --rule: #d7cdb8; --red: #9b2c2c; --green: #28543f; font-family: "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { background: var(--paper); color: var(--ink); margin: 0; }
  ${renderAdminHeaderStyles()}
  main { display: grid; gap: 1.5rem; margin: 0 auto; max-width: 90rem; padding: 1.5rem; }
  h1 { font-family: Montserrat, Arial, sans-serif; letter-spacing: -.035em; font-size: clamp(1.5rem, 3vw, 2.2rem); margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--rule); padding: .5rem .65rem; text-align: left; font-size: .92rem; }
  th { font-weight: 800; }
  button { background: var(--blue); border: 0; border-radius: .4rem; color: white; cursor: pointer; font: inherit; font-weight: 700; min-block-size: 2.25rem; padding: .4rem .75rem; }
  button:disabled { cursor: progress; opacity: .65; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  li { border: 1px solid var(--rule); border-radius: .5rem; padding: .75rem; background: var(--white); }
  a { color: var(--blue); }
</style>
</head>
<body>
${renderAdminHeader("signups")}
${body}
<script type="module">
const CSRF = ${token};
${script}
</script>
<script>${renderAdminHeaderScript()}</script>
</body>
</html>`;
}

export function renderSignupAdminPage(csrfToken: string): string {
  const body = `<main id="app">
  <p>Loading signups…</p>
</main>`;
  const script = `const app = document.querySelector('#app');
const response = await fetch('/api/signups-admin/v1/forms', {
  headers: { 'X-CSRF-Token': CSRF },
  credentials: 'same-origin',
});
const data = await response.json();
if (!response.ok) {
  app.textContent = data.error?.message ?? 'Unable to load signups.';
} else if (data.forms.length === 0) {
  app.textContent = 'No signup forms yet.';
} else {
  const list = document.createElement('ul');
  for (const form of data.forms) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '/admin/signups/' + encodeURIComponent(form.id);
    link.textContent = form.title + ' — ' + form.eventTitle;
    const meta = document.createElement('span');
    meta.textContent = ' · ' + form.state + ' · ' + form.responseCount + ' responses';
    item.append(link, meta);
    list.append(item);
  }
  app.replaceChildren(list);
}`;
  return renderSignupShell("Signups", csrfToken, body, script);
}

export function renderSignupAdminDetailPage(
  csrfToken: string,
  formId: string,
): string {
  const body = `<main id="app">
  <p>Loading signup…</p>
</main>`;
  const script = `const FORM_ID = ${scriptSafeJson(formId)};
const app = document.querySelector('#app');

function cell(row, text) {
  const td = document.createElement('td');
  td.textContent = text;
  row.append(td);
}

async function load() {
  const response = await fetch('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID), {
    headers: { 'X-CSRF-Token': CSRF },
    credentials: 'same-origin',
  });
  const data = await response.json();
  if (!response.ok) {
    app.textContent = data.error?.message ?? 'Unable to load this signup.';
    return;
  }

  const heading = document.createElement('h1');
  heading.textContent = data.form.title;

  const summary = document.createElement('p');
  summary.textContent =
    data.summary.families + ' families · ' +
    data.summary.attending + ' attending · ' +
    data.summary.adults + ' adults · ' +
    data.summary.children + ' children · ' +
    data.summary.unconfirmed + ' unconfirmed';

  const slots = document.createElement('ul');
  for (const slot of data.form.slots) {
    const claimed = data.responses
      .flatMap((entry) => entry.claims)
      .filter((claim) => claim.slotId === slot.id)
      .reduce((total, claim) => total + claim.quantity, 0);
    const item = document.createElement('li');
    item.textContent = slot.label + ': ' + claimed + ' of ' + slot.quantityNeeded + ' claimed';
    slots.append(item);
  }

  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const label of ['Family', 'Email', 'Attending', 'Adults', 'Children', 'Dietary', 'Bringing', 'Status', 'Signed up', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    header.append(th);
  }
  table.append(header);

  for (const entry of data.responses) {
    const row = document.createElement('tr');
    cell(row, entry.familyName);
    cell(row, entry.email);
    cell(row, entry.attending ? 'Yes' : 'No');
    cell(row, String(entry.adults));
    cell(row, String(entry.children));
    cell(row, entry.dietaryNotes ?? '—');
    cell(row, entry.claims.map((claim) => claim.label + ' ×' + claim.quantity).join(', ') || '—');
    cell(row, entry.status === 'confirmed' ? 'Confirmed' : 'Unconfirmed');
    cell(row, new Date(entry.createdAt).toLocaleDateString());

    const actions = document.createElement('td');
    const resend = document.createElement('button');
    resend.type = 'button';
    resend.textContent = 'Resend link';
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      await fetch('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id) + '/resend', {
        method: 'POST',
        headers: { 'X-CSRF-Token': CSRF },
        credentials: 'same-origin',
      });
      resend.textContent = 'Link sent';
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await fetch('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id), {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': CSRF },
        credentials: 'same-origin',
      });
      await load();
    });
    actions.append(resend, remove);
    row.append(actions);
    table.append(row);
  }

  app.replaceChildren(heading, summary, slots, table);
}

await load();`;
  return renderSignupShell("Signup detail", csrfToken, body, script);
}
