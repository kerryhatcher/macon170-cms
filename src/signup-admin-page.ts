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

export function diffRemovedSlotIds(
  loadedSlotIds: string[],
  currentRows: Array<{ id?: string }>,
): string[] {
  const kept = new Set(
    currentRows.map((row) => row.id).filter((id): id is string => Boolean(id)),
  );
  return loadedSlotIds.filter((id) => !kept.has(id));
}

export function countClaimedFamiliesBySlot(
  responses: Array<{ claims: Array<{ slotId: string }> }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const response of responses) {
    for (const claim of response.claims) {
      counts[claim.slotId] = (counts[claim.slotId] ?? 0) + 1;
    }
  }
  return counts;
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
  .toolbar { align-items: center; display: flex; gap: .75rem; justify-content: space-between; }
  .new-form { background: var(--blue); border-radius: .4rem; color: white; display: inline-flex; align-items: center; font-weight: 700; min-block-size: 2.25rem; padding: .4rem .75rem; text-decoration: none; }
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
  const body = `<main>
  <div class="toolbar">
    <h1>Signups</h1>
    <a class="new-form" href="/admin/signups/new">New form</a>
  </div>
  <div id="app"><p>Loading signups…</p></div>
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
  formId: string | null,
): string {
  const mode = formId === null ? "create" : "edit";
  const heading = mode === "create" ? "New signup form" : "Edit signup form";
  const saveLabel = mode === "create" ? "Create signup" : "Save changes";
  const responsesSection =
    mode === "edit"
      ? `<section aria-labelledby="responses-heading" id="responses-section">
    <h2 id="responses-heading">Responses</h2>
    <div id="responses">Loading responses…</div>
  </section>`
      : "";
  const body = `<main>
  <div class="toolbar">
    <h1>${heading}</h1>
    <a href="/admin/signups">← All signups</a>
  </div>
  <div id="notice" class="notice" hidden role="status"></div>
  <section aria-labelledby="settings-heading">
    <h2 id="settings-heading">Form settings</h2>
    <form id="settings-form">
      <div class="grid">
        <label>Title<input name="title" required minlength="2" maxlength="120"></label>
        <label>URL slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="80"></label>
        <label>Event<select name="eventId" id="event-select" required></select></label>
        <label>State<select name="state"><option value="draft">Draft</option><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <label class="wide">Instructions<textarea name="instructions" maxlength="2000"></textarea></label>
        <label>Closes at (optional)<input name="closesAt" type="datetime-local"></label>
        <label>Form type<select name="formType" id="form-type"><option value="rsvp">RSVP (attendance only)</option><option value="items">Items (families claim what to bring)</option></select></label>
      </div>
      <fieldset id="slot-editor" hidden>
        <div class="toolbar"><strong>Items</strong></div>
        <div id="slot-list"></div>
      </fieldset>
      <div class="actions">
        <button type="submit" id="save">${saveLabel}</button>
      </div>
    </form>
  </section>
  ${responsesSection}
</main>`;
  const script = `const MODE = ${scriptSafeJson(mode)};
const FORM_ID = ${scriptSafeJson(formId)};
const notice = document.querySelector('#notice');
const settingsForm = document.querySelector('#settings-form');
const saveButton = document.querySelector('#save');
const eventSelect = document.querySelector('#event-select');
const formTypeSelect = document.querySelector('#form-type');

let currentForm = null;

function showNotice(message, kind) {
  notice.textContent = message;
  notice.dataset.kind = kind || 'message';
  notice.hidden = false;
}

const request = async (path, options = {}) => {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers.set('X-CSRF-Token', CSRF);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Signup request failed.');
    error.status = response.status;
    throw error;
  }
  return payload;
};

function cell(row, text) {
  const td = document.createElement('td');
  td.textContent = text;
  row.append(td);
}

const localValue = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const utcValue = (value) => (value ? new Date(value).toISOString() : null);

function toggleSlotEditor(formType) {
  document.querySelector('#slot-editor').hidden = formType !== 'items';
}
formTypeSelect.addEventListener('change', (event) => toggleSlotEditor(event.target.value));

async function loadEventOptions(selectedEventId) {
  try {
    const data = await request('/api/calendar-admin/v1/events');
    const upcoming = data.events
      .filter((event) => event.publicationState !== 'archived' || event.id === selectedEventId)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    eventSelect.replaceChildren(
      ...upcoming.map((event) => {
        const option = document.createElement('option');
        option.value = event.id;
        option.textContent = event.title + ' — ' + new Date(event.startsAt).toLocaleDateString();
        return option;
      }),
    );
    if (selectedEventId) eventSelect.value = selectedEventId;
    eventSelect.disabled = false;
  } catch (error) {
    if (error.status === 403 && selectedEventId) {
      const option = document.createElement('option');
      option.value = selectedEventId;
      option.textContent = 'Current event (unchanged)';
      eventSelect.replaceChildren(option);
      eventSelect.disabled = true;
      showNotice(
        'Changing the event requires the calendar.manage permission — ask an administrator.',
        'error',
      );
    } else {
      throw error;
    }
  }
}

function renderResponses(form, responses, summary) {
  const container = document.querySelector('#responses');
  if (!container) return;
  container.replaceChildren();

  const summaryLine = document.createElement('p');
  summaryLine.textContent =
    summary.families + ' families · ' +
    summary.attending + ' attending · ' +
    summary.adults + ' adults · ' +
    summary.children + ' children · ' +
    summary.unconfirmed + ' unconfirmed';
  container.append(summaryLine);

  if (form.formType === 'items') {
    const slotSummary = document.createElement('ul');
    for (const slot of form.slots) {
      const claimedQuantity = responses
        .flatMap((entry) => entry.claims)
        .filter((claim) => claim.slotId === slot.id)
        .reduce((total, claim) => total + claim.quantity, 0);
      const item = document.createElement('li');
      item.textContent = slot.label + ': ' + claimedQuantity + ' of ' + slot.quantityNeeded + ' claimed';
      slotSummary.append(item);
    }
    container.append(slotSummary);
  }

  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const label of ['Family', 'Email', 'Attending', 'Adults', 'Children', 'Dietary', 'Bringing', 'Status', 'Signed up', '']) {
    const th = document.createElement('th');
    th.textContent = label;
    header.append(th);
  }
  table.append(header);

  for (const entry of responses) {
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
      await request('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id) + '/resend', { method: 'POST' });
      resend.textContent = 'Link sent';
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      await request('/api/signups-admin/v1/responses/' + encodeURIComponent(entry.id), { method: 'DELETE' });
      await loadForm();
    });
    actions.append(resend, remove);
    row.append(actions);
    table.append(row);
  }
  container.append(table);
}

function populateSettingsForm(form) {
  settingsForm.elements.namedItem('title').value = form.title;
  settingsForm.elements.namedItem('slug').value = form.slug;
  settingsForm.elements.namedItem('state').value = form.state;
  settingsForm.elements.namedItem('instructions').value = form.instructions;
  settingsForm.elements.namedItem('closesAt').value = localValue(form.closesAt);
  settingsForm.elements.namedItem('formType').value = form.formType;
  toggleSlotEditor(form.formType);
}

async function loadForm() {
  const data = await request('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID));
  currentForm = data.form;
  populateSettingsForm(currentForm);
  renderResponses(currentForm, data.responses, data.summary);
  await loadEventOptions(currentForm.eventId);
}

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(settingsForm).entries());
  const payload = {
    slug: values.slug,
    // A disabled <select> is excluded from FormData entirely, so when the
    // event picker is disabled (403 degrade path — no calendar.manage),
    // values.eventId is undefined. Fall back to the loaded form's own
    // eventId so an unrelated settings change (title, instructions, state,
    // ...) doesn't silently drop the event and fail validation.
    eventId: eventSelect.disabled ? currentForm?.eventId : values.eventId,
    formType: values.formType,
    title: values.title,
    instructions: values.instructions,
    state: values.state,
    closesAt: utcValue(values.closesAt),
    slots: [],
  };

  saveButton.disabled = true;
  try {
    if (MODE === 'create') {
      const created = await request('/api/signups-admin/v1/forms', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      window.location.href = '/admin/signups/' + encodeURIComponent(created.form.id);
      return;
    }
    await request('/api/signups-admin/v1/forms/' + encodeURIComponent(FORM_ID), {
      method: 'PUT',
      body: JSON.stringify({ ...payload, expectedRevision: currentForm.revision }),
    });
    showNotice('Signup saved.');
    await loadForm();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

if (MODE === 'create') {
  toggleSlotEditor('rsvp');
  loadEventOptions(null).catch((error) => showNotice(error.message, 'error'));
} else {
  loadForm().catch((error) => showNotice(error.message, 'error'));
}`;
  return renderSignupShell(
    mode === "create" ? "New signup" : "Signup detail",
    csrfToken,
    body,
    script,
  );
}
