export function renderCalendarAdminPage(csrfToken: string): string {
  const token = JSON.stringify(csrfToken).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Calendar management | Pack 170 CMS</title>
  <style>
    :root { color-scheme: light; --blue: #003f87; --deep: #002b5c; --gold: #fcd116; --paper: #f7f1e3; --white: #fffdf7; --ink: #272b2e; --muted: #59636b; --rule: #d7cdb8; --red: #9b2c2c; --green: #28543f; font-family: "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { background: var(--paper); color: var(--ink); margin: 0; }
    header { align-items: center; background: var(--deep); color: white; display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; padding: 1rem clamp(1rem, 4vw, 3rem); }
    header a { color: white; }
    header strong { font-size: 1.15rem; }
    main { display: grid; gap: 1.5rem; margin: 0 auto; max-width: 90rem; padding: 1.5rem; }
    .notice { border-inline-start: 4px solid var(--blue); background: #e8f0f8; padding: .8rem 1rem; }
    .notice[data-kind="error"] { background: #fbe9e7; border-color: var(--red); }
    .layout { display: grid; gap: 1.5rem; grid-template-columns: minmax(18rem, .7fr) minmax(25rem, 1.3fr); }
    section { background: var(--white); border: 1px solid var(--rule); border-radius: .6rem 1rem .7rem .6rem; padding: 1.25rem; }
    h1, h2 { font-family: Montserrat, Arial, sans-serif; letter-spacing: -.035em; margin: 0; }
    h1 { font-size: clamp(1.5rem, 3vw, 2.2rem); }
    h2 { font-size: 1.3rem; margin-bottom: 1rem; }
    .toolbar { align-items: center; display: flex; gap: .75rem; justify-content: space-between; margin-bottom: 1rem; }
    .events { display: grid; gap: .65rem; list-style: none; margin: 0; padding: 0; }
    .event { border: 1px solid var(--rule); border-radius: .5rem; padding: .85rem; }
    .event button { background: none; color: var(--blue); min-block-size: auto; padding: 0; text-align: left; }
    .event small { color: var(--muted); display: block; margin-top: .35rem; }
    form { display: grid; gap: 1rem; }
    .grid { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    label { display: grid; font-weight: 700; gap: .4rem; }
    label.wide { grid-column: 1 / -1; }
    input, textarea, select { background: white; border: 1px solid #9b9589; border-radius: .35rem; color: var(--ink); font: inherit; min-block-size: 2.75rem; padding: .55rem .65rem; width: 100%; }
    textarea { min-block-size: 6rem; resize: vertical; }
    input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
    button { background: var(--blue); border: 0; border-radius: .4rem; color: white; cursor: pointer; font: inherit; font-weight: 700; min-block-size: 2.75rem; padding: .65rem .9rem; }
    button.secondary { background: #59636b; }
    button.danger { background: var(--red); }
    button:disabled { cursor: progress; opacity: .65; }
    .actions { display: flex; flex-wrap: wrap; gap: .75rem; }
    .status { border-radius: 99px; display: inline-block; font-size: .75rem; font-weight: 800; padding: .2rem .55rem; text-transform: uppercase; }
    .status--published { background: #dff0e5; color: var(--green); }
    .status--draft { background: #e7e9eb; color: #42494f; }
    .status--archived { background: #f4e5e3; color: #71342e; }
    @media (max-width: 850px) { .layout, .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <strong>Pack 170 CMS</strong>
    <nav><a href="https://www.macon170.com">Public site</a> · <a href="/admin/dashboard">CMS dashboard</a> · <a href="/auth/logout">Sign out</a></nav>
  </header>
  <main>
    <div>
      <h1>Calendar management</h1>
      <p>Create, review, and publish the events families see on the Pack website.</p>
    </div>
    <div id="notice" class="notice" hidden role="status"></div>
    <div class="layout">
      <section aria-labelledby="events-heading">
        <div class="toolbar">
          <h2 id="events-heading">Events</h2>
          <button type="button" id="new-event">New event</button>
        </div>
        <ul class="events" id="events"><li>Loading events…</li></ul>
      </section>
      <section aria-labelledby="editor-heading">
        <h2 id="editor-heading">New event</h2>
        <form id="event-form">
          <div class="grid">
            <label>Title<input name="title" required minlength="3" maxlength="160"></label>
            <label>URL slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="80"></label>
            <label>Category<select name="category"><option value="pack">Pack</option><option value="den">Den</option><option value="family">Family</option></select></label>
            <label>Event status<select name="eventStatus"><option value="scheduled">Scheduled</option><option value="tentative">Tentative</option><option value="cancelled">Cancelled</option></select></label>
            <label>Starts at<input name="startsAt" type="datetime-local" required></label>
            <label>Ends at<input name="endsAt" type="datetime-local"></label>
            <label class="wide">Summary<textarea name="summary" required minlength="10" maxlength="500"></textarea></label>
            <label class="wide">Description<textarea name="description" required minlength="10" maxlength="8000"></textarea></label>
            <label>Location<input name="locationName" maxlength="200"></label>
            <label>Address<input name="address" maxlength="300"></label>
            <label class="wide">Audience<input name="audience" required minlength="2" maxlength="300"></label>
            <label class="wide">What to bring<textarea name="whatToBring" maxlength="2000"></textarea></label>
            <label>Cost<input name="cost" maxlength="500"></label>
            <label>Registration URL<input name="registrationUrl" type="url" maxlength="2000"></label>
            <label>Program milestone<select name="milestone"><option value="">None</option><option value="lego-derby">Lego Derby</option><option value="fall-camp">Fall Camp</option><option value="pinewood-derby">Pinewood Derby</option><option value="blue-gold">Blue and Gold</option></select></label>
          </div>
          <div class="actions">
            <button type="submit" id="save">Save draft</button>
            <button type="button" id="publish" hidden>Publish</button>
            <button type="button" id="archive" class="danger" hidden>Archive</button>
          </div>
        </form>
      </section>
    </div>
  </main>
  <script>
    const csrfToken = ${token};
    const api = '/api/calendar-admin/v1';
    const form = document.querySelector('#event-form');
    const list = document.querySelector('#events');
    const notice = document.querySelector('#notice');
    const heading = document.querySelector('#editor-heading');
    const publishButton = document.querySelector('#publish');
    const archiveButton = document.querySelector('#archive');
    let selected = null;
    let events = [];

    const showNotice = (message, kind = 'message') => {
      notice.textContent = message;
      notice.dataset.kind = kind;
      notice.hidden = false;
    };
    const request = async (path, options = {}) => {
      const headers = new Headers(options.headers);
      if (options.body) headers.set('Content-Type', 'application/json');
      if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers.set('X-CSRF-Token', csrfToken);
      const response = await fetch(api + path, { ...options, headers, credentials: 'same-origin' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || 'Calendar request failed.');
      return payload;
    };
    const localValue = (iso) => {
      if (!iso) return '';
      const date = new Date(iso);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const utcValue = (value) => value ? new Date(value).toISOString() : null;
    const values = () => Object.fromEntries(new FormData(form).entries());
    const payload = () => {
      const data = values();
      return {
        title: data.title, slug: data.slug, category: data.category,
        eventStatus: data.eventStatus, startsAt: utcValue(data.startsAt),
        endsAt: utcValue(data.endsAt), timezone: 'America/New_York',
        summary: data.summary, description: data.description,
        locationName: data.locationName || null, address: data.address || null,
        audience: data.audience, whatToBring: data.whatToBring || null,
        cost: data.cost || null, registrationUrl: data.registrationUrl || null,
        milestone: data.milestone || null
      };
    };
    const edit = (event) => {
      selected = event;
      heading.textContent = event ? 'Edit event' : 'New event';
      form.reset();
      for (const [key, value] of Object.entries(event || {})) {
        const field = form.elements.namedItem(key);
        if (field) field.value = ['startsAt', 'endsAt'].includes(key) ? localValue(value) : (value ?? '');
      }
      publishButton.hidden = !event || event.publicationState === 'published';
      archiveButton.hidden = !event || event.publicationState === 'archived';
      document.querySelector('#save').textContent = event ? 'Save changes' : 'Save draft';
    };
    const render = () => {
      list.replaceChildren();
      if (!events.length) {
        const item = document.createElement('li');
        item.textContent = 'No calendar events yet.';
        list.append(item);
        return;
      }
      for (const event of events) {
        const item = document.createElement('li');
        item.className = 'event';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = event.title;
        button.addEventListener('click', () => edit(event));
        const status = document.createElement('span');
        status.className = 'status status--' + event.publicationState;
        status.textContent = event.publicationState;
        const details = document.createElement('small');
        details.textContent = new Date(event.startsAt).toLocaleString() + ' · ' + event.eventStatus + ' · revision ' + event.revision;
        item.append(button, document.createTextNode(' '), status, details);
        list.append(item);
      }
    };
    const load = async () => {
      const payload = await request('/events');
      events = payload.events;
      render();
      if (selected) edit(events.find((event) => event.id === selected.id) || null);
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        if (selected) {
          await request('/events/' + selected.id, { method: 'PATCH', body: JSON.stringify({ ...payload(), expectedRevision: selected.revision }) });
        } else {
          await request('/events', { method: 'POST', body: JSON.stringify(payload()) });
        }
        showNotice('Event saved.');
        await load();
      } catch (error) { showNotice(error.message, 'error'); }
    });
    const transition = async (state) => {
      if (!selected) return;
      try {
        await request('/events/' + selected.id + '/' + state, { method: 'POST', body: JSON.stringify({ expectedRevision: selected.revision }) });
        showNotice(state === 'publish' ? 'Event published.' : 'Event archived.');
        await load();
      } catch (error) { showNotice(error.message, 'error'); }
    };
    publishButton.addEventListener('click', () => transition('publish'));
    archiveButton.addEventListener('click', () => transition('archive'));
    document.querySelector('#new-event').addEventListener('click', () => edit(null));
    load().catch((error) => showNotice(error.message, 'error'));
  </script>
</body>
</html>`;
}
