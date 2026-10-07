import {
  renderAdminHeader,
  renderAdminHeaderScript,
  renderAdminHeaderStyles,
} from "./admin-header";

export interface PendingInvitation {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
}

const roleLabels = new Map([
  ["viewer", "Viewer"], ["author", "Author"], ["editor", "Editor"], ["admin", "Administrator"],
]);

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderInvitePage(csrfToken: string, pending: PendingInvitation[] | null = []): string {
  const pendingContent = pending === null
    ? '<p class="notice notice--error" role="alert">Pending invitations could not be loaded. Refresh this page before resending.</p>'
    : pending.length
    ? `<ul class="pending-list">${pending.map((invitation) => `<li>
      <div class="pending-details"><h3>${escapeHtml(`${invitation.first_name} ${invitation.last_name}`.trim())}</h3>
      <p>${escapeHtml(invitation.email)}</p><p class="pending-role">${escapeHtml(roleLabels.get(invitation.role) ?? invitation.role)}</p></div>
      <button type="button" data-resend-url="/admin/resend-invitation/${encodeURIComponent(invitation.id)}">Resend invitation</button>
      <div class="pending-feedback" data-resend-feedback aria-live="polite"></div>
    </li>`).join("")}</ul>`
    : '<p>No pending invitations.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Invite a volunteer | Pack 170 CMS</title><style>
:root{color-scheme:light;--blue:#003f87;--deep:#002b5c;--gold:#fcd116;--ink:#272b2e;--muted:#5d6670;--paper:#fffdf5;--rule:#ccd6e0;--green:#1f6b45;--red:#9b2c2c}*{box-sizing:border-box}body{margin:0;background:#f8f7f2;color:var(--ink);font:16px/1.5 system-ui,sans-serif}a{color:var(--blue)}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:#fff;padding:.75rem;z-index:10}${renderAdminHeaderStyles()}main{max-width:760px;margin:auto;padding:clamp(1.5rem,4vw,3rem)}h1{font-size:clamp(2rem,5vw,3rem);line-height:1.1;margin:0 0 .65rem}.intro{color:var(--muted);margin:0 0 2rem;max-width:62ch}.card{background:var(--paper);border:1px solid var(--rule);border-radius:8px 22px 12px 8px;padding:clamp(1.25rem,3vw,2rem);box-shadow:6px 8px 0 rgba(0,43,92,.08)}form{display:grid;gap:1.25rem}label{display:grid;font-weight:700;gap:.45rem}input,select,button{font:inherit}input,select{background:white;border:1px solid var(--rule);border-radius:6px;min-height:2.8rem;padding:.6rem .7rem}button{background:var(--blue);border:0;border-radius:6px 12px 8px 6px;color:white;cursor:pointer;font-weight:800;min-height:3rem;padding:.75rem 1rem}button:hover{background:var(--deep)}button:disabled{cursor:progress;opacity:.7}.notice{border-inline-start:4px solid;margin:1.25rem 0 0;padding:.8rem 1rem}.notice--success{background:#e8f4ec;border-color:var(--green);color:#164b30}.notice--error{background:#fbe9e7;border-color:var(--red);color:#6f251f}.help{color:var(--muted);font-size:.92rem;margin:1.5rem 0 0}input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{box-shadow:0 0 0 4px var(--gold);outline:3px solid var(--deep);outline-offset:1px}@media(max-width:640px){main{padding:1.25rem}.card{padding:1.25rem}}
.pending{margin-top:2.5rem}.pending h2{margin-bottom:.5rem}.pending-list{list-style:none;padding:0;margin:1.5rem 0}.pending-list li{display:flex;flex-wrap:wrap;align-items:center;gap:1rem;padding:1.25rem 0;border-top:1px solid var(--rule)}.pending-details{flex:1 1 15rem;min-width:0;overflow-wrap:anywhere}.pending-details h3,.pending-details p{margin:0}.pending-details h3{font-size:1.1rem}.pending-role{color:var(--muted);font-size:.92rem}.pending-feedback{flex-basis:100%}.pending-feedback:empty{display:none}.pending-feedback .notice{margin:0}.pending-refresh{display:inline-block;margin-top:.75rem}button:disabled{cursor:default}
</style></head><body><a class="skip" href="#main">Skip to invitation form</a>${renderAdminHeader("dash")}<main id="main"><h1>Invite a volunteer</h1><p class="intro">Send a one-time setup link. The volunteer chooses their own password and receives only the role selected below.</p><section class="card" aria-labelledby="invite-form-title"><h2 id="invite-form-title">Volunteer details</h2><form id="invite-form" action="/admin/invite-user" method="post"><label for="first-name">First name<input id="first-name" name="first_name" autocomplete="given-name" required></label><label for="last-name">Last name<input id="last-name" name="last_name" autocomplete="family-name" required></label><label for="email">Email address<input id="email" name="email" type="email" autocomplete="email" required></label><label for="role">CMS role<select id="role" name="role" required><option value="viewer">Viewer — view content</option><option value="author">Author — draft content</option><option value="editor">Editor — manage content</option><option value="admin">Administrator — full CMS access</option></select></label><button type="submit">Send invitation</button></form><div id="feedback" aria-live="polite"></div></section><p class="help">Invitation links expire after seven days. Never share an invitation link outside its intended recipient.</p><section class="pending" aria-labelledby="pending-title"><h2 id="pending-title">Pending invitations</h2><p>Resend a fresh setup link to the same volunteer, keeping their existing role. The previous link will no longer work.</p><a class="pending-refresh" href="/admin/users/invite">Refresh pending invitations</a>${pendingContent}<p class="help">Showing up to 100 pending invitations. Accounts stay inactive until the volunteer completes setup.</p></section></main><script>
${renderAdminHeaderScript()}
const CSRF=${JSON.stringify(csrfToken)};
function showNotice(target,success,message){const notice=document.createElement('p');notice.className='notice '+(success?'notice--success':'notice--error');notice.setAttribute('role',success?'status':'alert');notice.textContent=message;target.replaceChildren(notice)}
function responseMessage(data){return data.message||(typeof data.error==='string'?data.error:data.error?.message)||'Unable to send the invitation. Reload this page and try again.'}
const form=document.querySelector('#invite-form');const feedback=document.querySelector('#feedback');const button=form.querySelector('button');
form.addEventListener('submit',async(event)=>{event.preventDefault();if(button.disabled)return;button.disabled=true;button.textContent='Sending…';feedback.replaceChildren();try{const response=await fetch(form.action,{method:'POST',headers:{'X-CSRF-Token':CSRF},body:new FormData(form),credentials:'same-origin'});const data=await response.json();showNotice(feedback,response.ok,responseMessage(data));if(response.ok)form.reset()}catch{showNotice(feedback,false,'Unable to confirm delivery. Reload this page and check pending invitations before trying again.')}finally{button.disabled=false;button.textContent='Send invitation'}});
document.querySelectorAll('[data-resend-url]').forEach((resend)=>{resend.addEventListener('click',async()=>{
  if(resend.disabled)return;
  const target=resend.closest('li').querySelector('[data-resend-feedback]');
  resend.disabled=true;resend.textContent='Sending…';target.replaceChildren();let sent=false;
  try{const response=await fetch(resend.dataset.resendUrl,{method:'POST',headers:{'X-CSRF-Token':CSRF},credentials:'same-origin'});const data=await response.json();sent=response.ok;showNotice(target,sent,responseMessage(data))}
  catch{showNotice(target,false,'Unable to confirm delivery. Check your connection and delivery status before resending.')}
  finally{resend.disabled=sent;resend.textContent=sent?'Invitation sent':'Resend invitation'}
})});
</script></body></html>`;
}
