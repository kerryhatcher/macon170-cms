import {
  CONTACT_API_BASE,
  CONTACT_STATUS_LABELS,
  CONTACT_STATUSES,
} from "./contact";

export function renderContactAdminPage(csrfToken: string): string {
  const statusOptions = CONTACT_STATUSES.map(
    (status) =>
      `<option value="${status}">${CONTACT_STATUS_LABELS[status]}</option>`,
  ).join("");
  const filterButtons = [
    `<button type="button" data-status="" aria-pressed="true">All</button>`,
    ...CONTACT_STATUSES.map(
      (status) =>
        `<button type="button" data-status="${status}" aria-pressed="false">${CONTACT_STATUS_LABELS[status]}</button>`,
    ),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Parent inquiries | Pack 170 CMS</title>
  <style>
    :root{color-scheme:light;--blue:#003f87;--deep:#002b5c;--gold:#fcd116;--ink:#272b2e;--muted:#5d6670;--paper:#fffdf5;--wash:#eef5fb;--rule:#ccd6e0;--green:#1f6b45}
    *{box-sizing:border-box}body{margin:0;background:#f8f7f2;color:var(--ink);font:16px/1.5 system-ui,sans-serif}
    a{color:var(--blue)}button,select{font:inherit}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:#fff;padding:.75rem;z-index:10}
    header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem clamp(1rem,4vw,3rem);background:var(--deep);color:#fff}
    header a{color:#fff;font-weight:700;text-decoration:none}main{max-width:1200px;margin:auto;padding:clamp(1rem,4vw,3rem)}
    .intro{display:grid;grid-template-columns:1fr minmax(260px,360px);gap:2rem;align-items:end}.eyebrow{font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--blue)}
    h1{font-size:clamp(2.4rem,7vw,4.8rem);line-height:1;margin:.25rem 0}.safety{padding:1.25rem;background:var(--green);color:#fff;border-radius:8px 20px 10px 8px}
    .filters{display:flex;gap:.5rem;margin:2rem 0 1rem;overflow:auto}.filters button{border:2px solid var(--blue);border-radius:999px;background:#fff;color:var(--blue);padding:.5rem 1rem;font-weight:700;white-space:nowrap}
    .filters button[aria-pressed="true"]{background:var(--blue);color:#fff}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.75rem}
    .pager{display:flex;gap:.5rem}.pager button{border:1px solid var(--rule);background:#fff;border-radius:6px;padding:.45rem .8rem}.pager button:disabled{opacity:.45}
    .desk{display:grid;grid-template-columns:370px 1fr;min-height:570px;border:1px solid var(--rule);border-radius:8px 22px 12px 8px;overflow:hidden;background:var(--paper);box-shadow:8px 10px 0 rgba(0,43,92,.12)}
    .list{list-style:none;margin:0;padding:0;border-right:1px solid var(--rule);background:var(--wash)}.row{display:grid;grid-template-columns:1fr auto;gap:.15rem .8rem;width:100%;padding:1rem;text-align:left;border:0;border-bottom:1px solid var(--rule);background:transparent;color:var(--ink);cursor:pointer}
    .row:hover,.row.active{background:#fff}.row.active{box-shadow:inset 5px 0 var(--blue)}.row b{grid-column:1}.row small{grid-column:1;color:var(--muted)}
    .state{align-self:start;border-radius:999px;padding:.15rem .5rem;background:#dce8f5;font-size:.78rem;font-weight:800}.detail{padding:clamp(1.5rem,4vw,3rem)}
    .empty{display:grid;place-items:center;align-content:center;gap:.4rem;min-height:400px;text-align:center;color:var(--muted)}.detail-head{display:flex;justify-content:space-between;gap:2rem;align-items:start;padding-bottom:1.5rem;border-bottom:3px solid var(--blue)}
    .detail-head h2{font-size:2rem;margin:0}.detail-head p{margin:.35rem 0;color:var(--muted)}select{min-height:44px;padding:.5rem;border:2px solid var(--blue);border-radius:7px;background:#fff}
    dl{margin:1.5rem 0}dl div{display:grid;grid-template-columns:130px 1fr;padding:.65rem 0;border-bottom:1px solid var(--rule)}dt{font-weight:800;color:var(--deep)}dd{margin:0}
    .message{margin-top:2rem;padding:1.5rem;background:#fff;border:1px solid var(--rule);border-radius:6px 16px 8px 6px}.message h3{margin-top:0}.privacy{color:var(--muted);font-size:.95rem}
    @media(max-width:800px){.intro,.desk{grid-template-columns:1fr}.desk{overflow:visible}.list{border-right:0;max-height:360px;overflow:auto}.detail{border-top:1px solid var(--rule)}.detail-head{display:grid}dl div{grid-template-columns:1fr}}
  </style>
</head>
<body>
<a class="skip" href="#main">Skip to inquiries</a>
<header><a href="/admin">Pack 170 CMS</a><nav><a href="/admin/calendar">Calendar</a></nav></header>
<main id="main">
  <section class="intro">
    <div><p class="eyebrow">Parent inquiries</p><h1>Volunteer queue</h1><p>Read parent questions, follow up through approved adult channels, and keep the queue current.</p></div>
    <div class="safety"><strong>Youth safety</strong><br>These are parent-to-adult messages. Do not move a conversation into a private adult-youth channel.</div>
  </section>
  <nav class="filters" aria-label="Submission status">${filterButtons}</nav>
  <div class="toolbar"><div id="queue-status" role="status">Loading submissions…</div><div class="pager"><button id="previous-page" type="button" disabled>Previous</button><button id="next-page" type="button" disabled>Next</button></div></div>
  <section class="desk">
    <ul id="submission-list" class="list" aria-label="Parent inquiries"></ul>
    <article id="submission-detail" class="detail" tabindex="-1"><div class="empty"><strong>Select a message</strong><span>Parent contact details and the full question will appear here.</span></div></article>
  </section>
</main>
<script>
const API=${JSON.stringify(CONTACT_API_BASE)};
const CSRF=${JSON.stringify(csrfToken)};
const STATUS_OPTIONS=${JSON.stringify(statusOptions)};
let currentStatus='';let page=1;let hasMore=false;let selectedId=null;let rows=[];
const list=document.querySelector('#submission-list');const detail=document.querySelector('#submission-detail');const queueStatus=document.querySelector('#queue-status');
const previous=document.querySelector('#previous-page');const next=document.querySelector('#next-page');
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
const formatDate=(value)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
async function load(){queueStatus.textContent='Loading submissions…';const query=new URLSearchParams({page:String(page)});if(currentStatus)query.set('status',currentStatus);try{const response=await fetch(API+'?'+query);if(!response.ok)throw new Error('Unable to load submissions.');const data=await response.json();rows=data.submissions;hasMore=data.hasMore;renderList();previous.disabled=page<=1;next.disabled=!hasMore;queueStatus.textContent=rows.length?rows.length+' message'+(rows.length===1?'':'s')+' on page '+page:'No messages in this view.';}catch(error){queueStatus.textContent=error instanceof Error?error.message:'Unable to load submissions.';}}
function renderList(){list.innerHTML=rows.map((row)=>'<li><button class="row '+(row.id===selectedId?'active':'')+'" data-id="'+esc(row.id)+'"><b>'+esc(row.parentName)+'</b><span class="state">'+esc(row.statusLabel)+'</span><small>'+esc(row.topic)+'</small><small>'+formatDate(row.submittedAt)+'</small></button></li>').join('');list.querySelectorAll('[data-id]').forEach((button)=>button.addEventListener('click',()=>openOne(button.dataset.id)));}
async function openOne(id){selectedId=id;renderList();detail.innerHTML='<div class="empty">Loading message…</div>';const response=await fetch(API+'/'+encodeURIComponent(id));if(!response.ok){detail.innerHTML='<div class="empty">Unable to load this message.</div>';detail.focus();return;}const data=await response.json();renderDetail(data.submission);detail.focus();}
function renderDetail(submission){const phone=submission.phone?'<a href="tel:'+esc(submission.phone)+'">'+esc(submission.phone)+'</a>':'Not supplied';const grade=submission.childGrade?esc(submission.childGrade):'Not supplied';detail.innerHTML='<div class="detail-head"><div><p class="eyebrow">'+esc(submission.topic)+'</p><h2>'+esc(submission.parentName)+'</h2><p>'+formatDate(submission.submittedAt)+'</p></div><select id="submission-status" aria-label="Submission status">'+STATUS_OPTIONS+'</select></div><dl><div><dt>Email</dt><dd><a href="mailto:'+esc(submission.email)+'">'+esc(submission.email)+'</a></dd></div><div><dt>Phone</dt><dd>'+phone+'</dd></div><div><dt>Child grade</dt><dd>'+grade+'</dd></div><div><dt>Country</dt><dd>'+esc(submission.countryCode||'Not available')+'</dd></div></dl><section class="message"><h3>Parent question</h3><p>'+esc(submission.message).replace(/\\n/g,'<br>')+'</p></section><p class="privacy">Use these details only to respond to this pack inquiry. Do not copy them into unapproved systems.</p>';const select=document.querySelector('#submission-status');select.value=submission.status;select.addEventListener('change',()=>updateStatus(submission.id,select.value,select));}
async function updateStatus(id,status,select){select.disabled=true;queueStatus.textContent='Saving status…';try{const response=await fetch(API+'/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':CSRF},body:JSON.stringify({status})});if(!response.ok)throw new Error('Unable to save status.');queueStatus.textContent='Status saved.';await load();}catch(error){queueStatus.textContent=error instanceof Error?error.message:'Unable to save status.';}finally{select.disabled=false;}}
document.querySelectorAll('[data-status]').forEach((button)=>button.addEventListener('click',()=>{currentStatus=button.dataset.status||'';page=1;selectedId=null;document.querySelectorAll('[data-status]').forEach((item)=>item.setAttribute('aria-pressed',String(item===button)));detail.innerHTML='<div class="empty"><strong>Select a message</strong><span>Parent contact details and the full question will appear here.</span></div>';load();}));
previous.addEventListener('click',()=>{if(page>1){page-=1;selectedId=null;load();}});next.addEventListener('click',()=>{if(hasMore){page+=1;selectedId=null;load();}});load();
</script>
</body>
</html>`;
}
