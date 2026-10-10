import {
  renderAdminHeader,
  renderAdminHeaderStyles,
  renderAdminHeaderScript,
} from "./admin-header";
import { escape } from "./broadcasts";

export function renderBroadcastAdminPage(csrf: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="${escape(csrf)}"><title>Email broadcasts · Pack 170 CMS</title><link rel="stylesheet" href="/email-editor/quill-2.0.3.css"><style>
:root{--deep:#173650;--gold:#f5c542}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;font:16px/1.5 system-ui;background:#f3f6f8;color:#173650}main{max-width:1120px;margin:2rem auto;padding:0 1rem}section{background:white;padding:1.5rem;margin:1.5rem 0;border:1px solid #ced9e1;border-radius:8px}h1,h2{line-height:1.2}label{display:block;margin:.8rem 0;font-weight:600}input:not([type=checkbox]),textarea,select{display:block;width:100%;padding:.65rem;border:1px solid #8195a6;border-radius:4px;font:inherit}textarea{min-height:200px}.ql-editor{min-height:240px;font:16px/1.6 Arial,sans-serif}.ql-toolbar button{margin:0}.ql-editor img{max-width:100%}#preview-frame{width:100%;max-width:640px;height:650px;border:1px solid #ced9e1;background:white;display:block;margin:1rem auto}#preview-size{max-width:240px}button{font:inherit;background:var(--deep);color:white;border:0;border-radius:5px;padding:.65rem 1rem;cursor:pointer;margin:.5rem .5rem .5rem 0}button:disabled{opacity:.5;cursor:wait}a{color:#175b8c}.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}.choices label{font-weight:400}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:.7rem;border-bottom:1px solid #ddd;vertical-align:top}#notice{position:sticky;top:0;background:#fff3bd;padding:1rem;z-index:30}#notice:empty{display:none}.muted{color:#506578}pre{white-space:pre-wrap;font:inherit}details{margin:1rem 0}summary{cursor:pointer;font-weight:700}@media(max-width:760px){.grid{grid-template-columns:1fr}}${renderAdminHeaderStyles()}</style></head><body>${renderAdminHeader("broadcasts")}<main><h1>Email broadcasts</h1><p>Create lists, manage subscribers, and send Pack updates.</p><p id="notice" role="status" aria-live="polite"></p><p id="configuration" class="muted"></p>
<div class="grid"><section><h2>Mailing lists</h2><form id="list-form"><label>List name<input name="name" required maxlength="100" placeholder="Pack announcements"></label><label>Signup URL slug<input name="slug" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="pack-announcements"></label><button>Create list</button></form><div id="lists"></div></section>
<section><h2>Contacts</h2><p>Add only people who have agreed to receive your emails.</p><form id="contact-form"><label>Name<input name="name" maxlength="100"></label><label>Email<input name="email" required type="email" maxlength="254"></label><button>Save contact</button></form><label>Find a contact<input id="search" type="search" placeholder="Name or email"></label><label for="contact-select">Contact</label><select id="contact-select"></select><p id="contact-status"></p><a id="contact-emails" hidden>View contact and incoming emails</a><div id="membership-choices" class="choices"></div><label><input id="membership-consent" type="checkbox"> This contact agreed to receive emails from the selected lists.</label><button id="add-lists" type="button">Add to selected lists</button><button id="remove-lists" type="button">Remove from selected lists</button><p class="muted">Checked lists are selected for the action. Current memberships are labeled. A subscriber’s opt-out cannot be overridden here.</p></section></div>
<section><h2 id="draft-title">Draft an email</h2><form id="draft-form"><input type="hidden" name="id"><label for="draft-list">Send to list</label><select name="listId" required id="draft-list"></select><label>Subject<input name="subject" required maxlength="200"></label><label id="message-label">Message</label><div id="email-editor"></div><textarea id="plain-message" name="body" maxlength="20000" aria-label="Email message" hidden></textarea><p class="muted">Use {{name}} for a recipient’s name. Previews and the public web copy use “friend”. Sending publishes a shareable web copy without recipient-specific links. Every delivered email includes unsubscribe links.</p><button>Save draft</button><button id="preview-draft" type="button">Preview email</button><button id="new-draft" type="button">New draft</button></form></section>
<section id="email-preview" hidden><h2>Email preview</h2><p class="muted">Generic preview without recipient-specific values. Email apps may display spacing and fonts differently.</p><label for="preview-size">Preview size</label><select id="preview-size"><option value="640">Desktop</option><option value="375">Mobile</option></select><iframe id="preview-frame" title="Email preview" sandbox=""></iframe></section><section><h2>Drafts and sent emails</h2><p>Open counts are approximate: privacy tools and image blocking affect tracking. “Accepted” means Postmark accepted the message, while “Delivered” means the receiving mail server accepted it.</p><button id="refresh" type="button">Refresh stats</button><div id="campaigns"></div><p class="muted">Shows the latest 200 emails. Contacts are limited to the first 5,000; memberships to 20,000. Sending runs in the background in batches of 10 per minute.</p></section></main><script src="/email-editor/quill-2.0.3.js"></script><script>
${renderAdminHeaderScript()}
const $ = (id) => document.getElementById(id);
const editor = typeof Quill !== 'undefined' ? new Quill('#email-editor', {
  theme:'snow', placeholder:'Write your Pack update…',
  formats:['header','bold','italic','underline','strike','blockquote','list','link','image','color','background','align'],
  modules:{toolbar:[[{header:[1,2,3,false]}],['bold','italic','underline','strike'],[{color:[]},{background:[]}],[{list:'ordered'},{list:'bullet'},'blockquote'],[{align:[]}],['link','image','clean']]},
}) : null;
if (editor) {
  for (const [format,label] of [['header','Heading style'],['color','Text color'],['background','Highlight color'],['align','Text alignment']]) document.querySelector('.ql-' + format + ' .ql-picker-label')?.setAttribute('aria-label',label);
  editor.root.setAttribute('role','textbox'); editor.root.setAttribute('aria-label','Email message'); editor.root.setAttribute('aria-multiline','true');
  editor.getModule('toolbar').addHandler('image', () => {
    const source = prompt('Enter the HTTPS URL of an image'); if (!source) return;
    try { const url = new URL(source); if(url.protocol !== 'https:') throw new Error(); const position = editor.getSelection(true); editor.insertEmbed(position.index,'image',url.href,'user'); }
    catch { notice('Use a complete HTTPS image URL.'); }
  });
} else { $('plain-message').hidden = false; notice('The visual editor did not load. You can still write plain text or reload the page.'); }
let data = { lists: [], contacts: [], memberships: [], campaigns: [] };
function notice(message) {
  $("notice").textContent = message;
}
async function api(path = "", body) {
  const response = await fetch("/api/broadcasts/v1" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]').content,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Request failed");
  return result;
}
function node(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
function option(value, text) {
  const el = node("option", text);
  el.value = value;
  return el;
}
function contacts() {
  const previous = $("contact-select").value,
    search = $("search").value.toLowerCase();
  $("contact-select").replaceChildren(option("", "Choose a contact"));
  data.contacts
    .filter((c) => (c.email + " " + c.name).toLowerCase().includes(search))
    .forEach((c) =>
      $("contact-select").append(
        option(c.id, c.name ? c.name + " — " + c.email : c.email),
      ),
    );
  $("contact-select").value = previous;
  memberships();
}
function memberships() {
  $("membership-consent").checked = false;
  const c = data.contacts.find((c) => c.id === $("contact-select").value);
  $("contact-status").textContent = c
    ? c.tag
      ? "Status: " + c.tag
      : "Status: active"
    : "Select a contact to manage lists.";
  $("contact-emails").hidden = !c;
  $("contact-emails").href = c ? "/admin/inbox?contactId=" + encodeURIComponent(c.id) : "#";
  $("membership-choices").replaceChildren();
  data.lists.forEach((l) => {
    const label = node("label", "");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = l.id;
    const active = data.memberships.some(
      (m) => m.contact_id === c?.id && m.list_id === l.id,
    );
    label.append(
      input,
      document.createTextNode(" " + l.name + (active ? " (member)" : "")),
    );
    $("membership-choices").append(label);
  });
}
function draft(c) {
  const f = $("draft-form");
  f.elements.namedItem("id").value = c.id;
  f.elements.namedItem("subject").value = c.subject;
  if (editor) { c.body_html ? editor.clipboard.dangerouslyPasteHTML(c.body_html) : editor.setText(c.body); }
  $("plain-message").value = c.body;
  $("email-preview").hidden = true;
  f.elements.namedItem("listId").value = c.list_id;
  $("draft-title").textContent = "Edit draft";
  f.scrollIntoView({ behavior: "smooth" });
}
async function load() {
  data = await api();
  $("configuration").textContent = data.configured
    ? "Email delivery is configured."
    : "Sending is disabled until the broadcast sender, stream, origin and webhook secret are configured.";
  $("lists").replaceChildren();
  const selected = $("draft-list").value;
  $("draft-list").replaceChildren(option("", "Choose a list"));
  data.lists.forEach((l) => {
    const p = node("p", "");
    const name = node("a", l.name);
    name.href = "/admin/broadcasts/lists/" + encodeURIComponent(l.id);
    p.append(name, document.createTextNode(" · " + l.members + " subscribers · "));
    const link = node("a", "Signup page");
    link.href = "/email/signup/" + encodeURIComponent(l.slug);
    link.target = "_blank";
    link.rel = "noopener";
    p.append(link);
    $("lists").append(p);
    $("draft-list").append(option(l.id, l.name));
  });
  $("draft-list").value = selected;
  contacts();
  $("campaigns").replaceChildren();
  data.campaigns.forEach((c) => {
    const detail = document.createElement("details");
    detail.append(node("summary", c.subject + " · " + c.state));
    detail.append(
      node(
        "p",
        (data.lists.find((l) => l.id === c.list_id)?.name || "List") +
          " · " +
          new Date(c.created_at).toLocaleString(),
      ),
    );
    detail.append(node("pre", c.body));
    const preview = node('button', 'Preview email'); preview.type = 'button';
    preview.onclick = () => action(preview, () => showPreview({subject:c.subject,body:c.body,html:c.body_html}));
    detail.append(preview);
    if (c.state !== 'draft' && c.accepted > 0) { const web = node('a','View public web copy'); web.href = '/email/messages/' + encodeURIComponent(c.id); web.target = '_blank'; web.rel = 'noopener'; detail.append(web); }
    if (c.state === "draft") {
      const edit = node("button", "Edit draft");
      edit.type = "button";
      edit.onclick = () => draft(c);
      const send = node("button", "Send to list");
      send.type = "button";
      send.disabled = !data.configured;
      send.onclick = () =>
        action(send, async () => {
          const list = data.lists.find((l) => l.id === c.list_id);
          if (
            !confirm(
              "Send “" +
                c.subject +
                "” to " +
                (list?.members || 0) +
                " subscribers in " +
                list?.name +
                "?",
            )
          )
            return;
          await api("/send", { id: c.id });
          notice("Email queued. Refresh stats to follow delivery.");
          await load();
        });
      detail.append(edit, send);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      const table = document.createElement("table");
      const head = document.createElement("tr"),
        row = document.createElement("tr");
      [
        "recipients",
        "accepted",
        "delivered",
        "opened",
        "bounced",
        "skipped",
        "unknown",
      ].forEach((key) => {
        head.append(node("th", key));
        row.append(node("td", String(c[key])));
      });
      table.append(head, row);
      wrap.append(table);
      detail.append(wrap);
      if (c.unknown)
        detail.append(
          node(
            "p",
            "Some deliveries are uncertain. Check Postmark Activity before sending another message to these recipients.",
          ),
        );
    }
    $("campaigns").append(detail);
  });
}
async function action(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (error) {
    notice(error.message);
  } finally {
    button.disabled = false;
  }
}
for (const [id, path] of [
  ["list-form", "/lists"],
  ["contact-form", "/contacts"],
]) {
  $(id).onsubmit = (event) => {
    event.preventDefault();
    const form = $(id);
    action(form.querySelector("button"), async () => {
      await api(path, Object.fromEntries(new FormData(form)));
      form.reset();
      const idField = form.elements.namedItem("id");
      if (idField) idField.value = "";
      notice("Saved.");
      await load();
    });
  };
}
for (const [id, operation] of [
  ["add-lists", "add"],
  ["remove-lists", "remove"],
]) {
  $(id).onclick = () =>
    action($(id), async () => {
      await api("/memberships", {
        contactId: $("contact-select").value,
        listIds: Array.from(
          $("membership-choices").querySelectorAll("input:checked"),
        ).map((i) => i.value),
        action: operation,
        consent: $("membership-consent").checked,
      });
      notice("List memberships updated.");
      await load();
    });
}
function currentDraft() {
  const form = $('draft-form');
  return {id:form.elements.namedItem('id').value,listId:form.elements.namedItem('listId').value,subject:form.elements.namedItem('subject').value,...(editor ? {html:editor.getSemanticHTML()} : {body:$('plain-message').value})};
}
async function showPreview(content) {
  const result = await api('/preview', content);
  $('preview-frame').srcdoc = result.html; $('email-preview').hidden = false;
  $('email-preview').scrollIntoView({behavior:'smooth'});
}
$('draft-form').onsubmit = event => {
  event.preventDefault(); const form = $('draft-form');
  action(form.querySelector('button'), async () => { const result = await api('/drafts', currentDraft()); form.elements.namedItem('id').value = result.id; $('draft-title').textContent = 'Edit draft'; notice('Draft saved.'); await load(); });
};
$('preview-draft').onclick = () => action($('preview-draft'), () => showPreview(currentDraft()));
$('preview-size').onchange = () => { $('preview-frame').style.maxWidth = $('preview-size').value + 'px'; };
$("new-draft").onclick = () => {
  $("draft-form").reset();
  if (editor) editor.setText("");
  $("plain-message").value = "";
  $("email-preview").hidden = true;
  $("draft-form").elements.namedItem("id").value = "";
  $("draft-title").textContent = "Draft an email";
};
$("search").oninput = contacts;
$("contact-select").onchange = memberships;
$("refresh").onclick = () => action($("refresh"), load);
load().catch((error) => notice(error.message));
</script></body></html>`;
}
