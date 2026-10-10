import {
  renderAdminHeader,
  renderAdminHeaderStyles,
  renderAdminHeaderScript,
} from "./admin-header";
import { escape } from "./broadcasts";

export function renderBroadcastListPage(csrf: string, listId: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="${escape(csrf)}"><title>Mailing list · Pack 170 CMS</title><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui;background:#f3f6f8;color:#173650}main{max-width:1120px;margin:2rem auto;padding:0 1rem}section{background:white;padding:1.5rem;margin:1.5rem 0;border:1px solid #ced9e1;border-radius:8px}h1,h2{line-height:1.2}a{color:#175b8c}label{display:block;margin:.8rem 0;font-weight:600}input:not([type=checkbox]){display:block;width:100%;padding:.65rem;border:1px solid #8195a6;border-radius:4px;font:inherit}button{font:inherit;background:#173650;color:white;border:0;border-radius:5px;padding:.65rem 1rem;cursor:pointer;margin:.5rem .5rem .5rem 0}button:disabled{opacity:.5;cursor:not-allowed}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:.7rem;border-bottom:1px solid #ddd;vertical-align:top}td.email{overflow-wrap:anywhere}#notice{background:#fff3bd;padding:1rem}#notice:empty{display:none}.muted{color:#506578}@media(max-width:600px){section{padding:1rem}th,td{padding:.5rem}}${renderAdminHeaderStyles()}</style></head><body>${renderAdminHeader("broadcasts")}<main data-list-id="${escape(listId)}"><a href="/admin/broadcasts">← All mailing lists and broadcasts</a><h1 id="title">Mailing list</h1><p id="notice" role="status" aria-live="polite"></p><div id="content" hidden>
<section><h2>List settings</h2><form id="settings"><label>List name<input name="name" required maxlength="100"></label><label>Signup URL slug<input name="slug" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label><p class="muted">Changing the slug changes the public signup address. Existing subscriptions stay on this list.</p><button>Save changes</button></form><a id="signup" target="_blank" rel="noopener">Open signup page</a></section>
<section><h2>Contacts in this list</h2><p id="count"></p><label>Find a contact<input id="search" type="search" placeholder="Name or email"></label><button id="remove-selected" type="button" disabled>Remove selected contacts</button><p class="muted">Removing a contact affects this list only. The contact stays in your contacts and any other lists. They can rejoin through the signup page.</p><div class="table-wrap"><table><thead><tr><th><input id="select-all" type="checkbox" aria-label="Select all visible contacts"></th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody id="contacts"></tbody></table></div><p id="empty" hidden>No contacts match your search.</p><a href="/admin/broadcasts">Add contacts or manage other memberships</a></section></div></main><script>
${renderAdminHeaderScript()}
const $ = id => document.getElementById(id);
const listId = document.querySelector('main').dataset.listId;
let contacts = [], selected = new Set(), busy = false;
function notice(text) { $('notice').textContent = text; }
function node(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
async function api(path, body) {
  const response = await fetch('/api/broadcasts/v1' + path, {method: body ? 'POST' : 'GET', headers: {'Content-Type':'application/json','X-CSRF-Token':document.querySelector('meta[name="csrf-token"]').content}, ...(body ? {body:JSON.stringify(body)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Request failed.');
  return result;
}
function visible() { const search = $('search').value.toLowerCase(); return contacts.filter(c => (c.name + ' ' + c.email).toLowerCase().includes(search)); }
function selection() {
  const rows = visible();
  $('select-all').checked = rows.length > 0 && rows.every(c => selected.has(c.id));
  $('select-all').indeterminate = rows.some(c => selected.has(c.id)) && !$('select-all').checked;
  $('select-all').disabled = busy || rows.length === 0;
  $('remove-selected').disabled = busy || selected.size === 0;
  $('remove-selected').textContent = selected.size ? 'Remove selected contacts (' + selected.size + ')' : 'Remove selected contacts';
}
function render() {
  $('contacts').replaceChildren();
  const rows = visible();
  $('empty').hidden = rows.length > 0;
  $('count').textContent = contacts.length + (contacts.length === 1 ? ' contact · ' : ' contacts · ') + contacts.filter(c => !c.tag).length + ' eligible to receive emails';
  rows.forEach(c => {
    const row = document.createElement('tr'), cell = document.createElement('td'), check = document.createElement('input');
    check.type = 'checkbox'; check.checked = selected.has(c.id); check.disabled = busy; check.setAttribute('aria-label', 'Select ' + c.email);
    check.onchange = () => { check.checked ? selected.add(c.id) : selected.delete(c.id); selection(); };
    cell.append(check); row.append(cell); const nameCell=node('td',''), contactLink=node('a',c.name || c.email); contactLink.href='/admin/inbox?contactId='+encodeURIComponent(c.id); nameCell.append(contactLink); row.append(nameCell);
    const email = node('td', c.email); email.className = 'email'; row.append(email, node('td', c.tag || 'Subscribed'));
    const actions = document.createElement('td'), remove = node('button','Remove'); remove.type = 'button'; remove.disabled = busy; remove.setAttribute('aria-label','Remove ' + c.email); remove.onclick = () => removeContacts([c.id]); actions.append(remove); row.append(actions); $('contacts').append(row);
  });
  selection();
}
async function load() {
  const result = await api('/lists/' + encodeURIComponent(listId));
  contacts = result.contacts; selected = new Set([...selected].filter(id => contacts.some(c => c.id === id)));
  $('title').textContent = result.list.name; document.title = result.list.name + ' · Pack 170 CMS';
  $('settings').elements.namedItem('name').value = result.list.name; $('settings').elements.namedItem('slug').value = result.list.slug;
  $('signup').href = '/email/signup/' + encodeURIComponent(result.list.slug);
  $('content').hidden = false; render();
}
async function removeContacts(ids) {
  if (busy || !ids.length || !confirm('Remove ' + ids.length + ' contact(s) from this list? Their other lists will stay unchanged.')) return;
  busy = true; render(); let removed = 0;
  try {
    for (const contactId of ids) { await api('/memberships', {contactId,listIds:[listId],action:'remove'}); selected.delete(contactId); removed++; }
    notice(removed + ' contact(s) removed from this list.');
  } catch (error) { notice(removed + ' removed. ' + error.message); }
  finally { busy = false; await load().catch(error => notice(error.message)); render(); }
}
$('settings').onsubmit = async event => {
  event.preventDefault(); const button = $('settings').querySelector('button'); button.disabled = true;
  try { await api('/lists', {id:listId,...Object.fromEntries(new FormData($('settings')))}); await load(); notice('List settings saved.'); }
  catch (error) { notice(error.message); } finally { button.disabled = false; }
};
$('search').oninput = render;
$('select-all').onchange = () => { visible().forEach(c => $('select-all').checked ? selected.add(c.id) : selected.delete(c.id)); render(); };
$('remove-selected').onclick = () => removeContacts([...selected]);
load().catch(error => notice(error.message));
</script></body></html>`;
}
