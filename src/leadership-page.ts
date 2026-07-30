import {
  renderAdminHeader,
  renderAdminHeaderStyles,
  renderAdminHeaderScript,
} from "./admin-header";

export function renderLeadershipPage(csrfToken: string): string {
  const token = JSON.stringify(csrfToken).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Leadership roster | Pack 170 CMS</title>
  <style>
    :root{color-scheme:light;--blue:#003f87;--deep:#002b5c;--gold:#fcd116;--ink:#272b2e;--muted:#5d6670;--paper:#fffdf5;--wash:#eef5fb;--rule:#ccd6e0;--green:#1f6b45;--red:#9b2c2c}
    *{box-sizing:border-box}body{margin:0;background:#f8f7f2;color:var(--ink);font:16px/1.5 system-ui,sans-serif}
    a{color:var(--blue)}button,input,textarea,select{font:inherit}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:#fff;padding:.75rem;z-index:10}
    ${renderAdminHeaderStyles()}
    main{max-width:1200px;margin:auto;padding:clamp(1.5rem,4vw,3rem)}
    .hero{margin-bottom:2rem}.hero h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.1;margin:0 0 .5rem}.hero p{color:var(--muted);font-size:1.1rem;margin:0}
    .toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem}
    .toolbar button{background:var(--blue);color:#fff;border:0;border-radius:7px;padding:.6rem 1.2rem;font-weight:700;cursor:pointer;min-height:44px}
    .toolbar button:hover{background:var(--deep)}
    .section-group{margin-bottom:2.5rem}
    .section-group h2{font-size:1.15rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 .75rem;padding-bottom:.5rem;border-bottom:2px solid var(--rule)}
    .roster-table{width:100%;border-collapse:collapse;background:var(--paper);border:1px solid var(--rule);border-radius:8px 22px 12px 8px;overflow:hidden;box-shadow:6px 8px 0 rgba(0,43,92,.08)}
    .roster-table th{text-align:left;padding:.75rem 1rem;background:var(--wash);color:var(--deep);font-weight:800;font-size:.82rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid var(--rule)}
    .roster-table td{padding:.65rem 1rem;border-bottom:1px solid var(--rule);vertical-align:middle}
    .roster-table tr:last-child td{border-bottom:0}
    .roster-table .vacant{color:var(--muted);font-style:italic}
    .roster-table .actions{display:flex;gap:.4rem}
    .roster-table .actions button{border:0;border-radius:5px;padding:.35rem .65rem;font-size:.82rem;font-weight:700;cursor:pointer;min-height:36px}
    .btn-edit{background:var(--wash);color:var(--blue)}
    .btn-edit:hover{background:#d0e2f5}
    .btn-delete{background:#fbe9e7;color:var(--red)}
    .btn-delete:hover{background:#f4d4d0}
    .empty{text-align:center;padding:3rem 1rem;color:var(--muted)}
    .empty strong{display:block;font-size:1.1rem;margin-bottom:.3rem}
    /* Modal overlay */
    .modal-overlay{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.35);place-items:center}
    .modal-overlay[data-open="true"]{display:grid}
    .modal{background:var(--paper);border:1px solid var(--rule);border-radius:10px 26px 14px 10px;padding:2rem;width:min(520px,calc(100% - 2rem));max-height:90vh;overflow-y:auto;box-shadow:10px 12px 0 rgba(0,43,92,.15)}
    .modal h3{margin:0 0 1.25rem;font-size:1.3rem}
    .modal label{display:grid;gap:.35rem;margin-bottom:1rem;font-weight:700;font-size:.92rem}
    .modal input,.modal select,.modal textarea{border:1px solid var(--rule);border-radius:6px;padding:.55rem .7rem;min-height:44px;background:#fff;width:100%}
    .modal textarea{min-height:80px;resize:vertical}
    .modal .form-actions{display:flex;gap:.75rem;justify-content:flex-end;margin-top:1.5rem}
    .modal .form-actions button{border:0;border-radius:7px;padding:.6rem 1.2rem;font-weight:700;cursor:pointer;min-height:44px}
    .modal .btn-save{background:var(--blue);color:#fff}
    .modal .btn-save:hover{background:var(--deep)}
    .modal .btn-cancel{background:#e7e9eb;color:var(--ink)}
    .modal .btn-cancel:hover{background:#d4d7db}
    .modal .btn-delete-confirm{background:var(--red);color:#fff}
    .modal .btn-delete-confirm:hover{background:#7a2323}
    .notice{display:none;padding:.8rem 1rem;border-radius:6px;margin-bottom:1.5rem;font-weight:600}
    .notice[data-visible="true"]{display:block}
    .notice--success{background:#e8f4ec;color:var(--green);border:1px solid var(--green)}
    .notice--error{background:#fbe9e7;color:var(--red);border:1px solid var(--red)}
    @media(max-width:700px){.roster-table,.roster-table thead,.roster-table tbody,.roster-table tr,.roster-table th,.roster-table td{display:block}
    .roster-table thead{display:none}
    .roster-table td{padding:.5rem 1rem;border-bottom:1px solid var(--rule)}
    .roster-table td:last-child{border-bottom:2px solid var(--rule)}
    .roster-table td::before{content:attr(data-label);display:block;font-weight:800;font-size:.78rem;text-transform:uppercase;color:var(--muted);margin-bottom:.15rem}
    .roster-table .actions{justify-content:flex-start;margin-top:.35rem}}
  </style>
</head>
<body>
<a class="skip" href="#main">Skip to roster</a>
${renderAdminHeader("leadership")}
<main id="main">
  <div class="hero">
    <h1>Leadership roster</h1>
    <p>Manage the volunteer leadership directory shown on the Pack website.</p>
  </div>
  <div id="notice" class="notice" role="status"></div>
  <div class="toolbar">
    <span id="roster-count" role="status">Loading&hellip;</span>
    <button type="button" id="add-entry">Add role</button>
  </div>
  <div id="pack-leadership" class="section-group">
    <h2>Pack leadership</h2>
    <table class="roster-table" id="pack-table">
      <thead><tr><th>Role</th><th>Name</th><th>Order</th><th></th></tr></thead>
      <tbody id="pack-body"><tr><td colspan="4" class="empty">Loading&hellip;</td></tr></tbody>
    </table>
  </div>
  <div id="den-leaders" class="section-group">
    <h2>Den leaders</h2>
    <table class="roster-table" id="den-table">
      <thead><tr><th>Role</th><th>Name</th><th>Order</th><th></th></tr></thead>
      <tbody id="den-body"><tr><td colspan="4" class="empty">Loading&hellip;</td></tr></tbody>
    </table>
  </div>
</main>

<!-- Edit/Create modal -->
<div class="modal-overlay" id="modal-overlay" data-open="false" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="modal">
    <h3 id="modal-title">Add role</h3>
    <form id="entry-form">
      <input type="hidden" name="id" id="entry-id">
      <label>Role title <input name="title" id="field-title" required minlength="2" maxlength="120" placeholder="e.g. Cubmaster"></label>
      <label>Volunteer name <input name="name" id="field-name" maxlength="120" placeholder="Leave blank if vacant"></label>
      <label>Section
        <select name="section" id="field-section">
          <option value="pack-leadership">Pack leadership</option>
          <option value="den-leaders">Den leaders</option>
        </select>
      </label>
      <label>Display order <input name="sortOrder" id="field-sortOrder" type="number" min="0" value="0" required></label>
      <div class="form-actions">
        <button type="button" class="btn-cancel" id="modal-cancel">Cancel</button>
        <button type="submit" class="btn-save" id="modal-save">Save</button>
      </div>
    </form>
  </div>
</div>

<!-- Delete confirmation modal -->
<div class="modal-overlay" id="delete-overlay" data-open="false" role="dialog" aria-modal="true" aria-labelledby="delete-title">
  <div class="modal">
    <h3 id="delete-title">Delete role</h3>
    <p id="delete-message">Are you sure you want to delete this role?</p>
    <input type="hidden" id="delete-id">
    <div class="form-actions">
      <button type="button" class="btn-cancel" id="delete-cancel">Cancel</button>
      <button type="button" class="btn-delete-confirm" id="delete-confirm">Delete</button>
    </div>
  </div>
</div>

<script>
const CSRF=${token};
const COLLECTION="leadership-roster";
const API_BASE="/api/content";
const LIST_API="/api/collections/"+COLLECTION+"/content";

const esc=function(v){return String(v??"").replace(/[&<>"']/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]})};

function showNotice(msg,kind){var n=document.querySelector("#notice");n.textContent=msg;n.dataset.visible="true";n.className="notice notice--"+kind;setTimeout(function(){n.dataset.visible="false"},4000)}

async function apiFetch(url,opts){opts=opts||{};var headers=new Headers(opts.headers||{});if(opts.body)headers.set("Content-Type","application/json");if(opts.method&&opts.method!=="GET")headers.set("X-CSRF-Token",CSRF);var res=await fetch(url,Object.assign({},opts,{headers:headers,credentials:"same-origin"}));if(!res.ok){var body=await res.json().catch(function(){return{}});throw new Error(body.error||"Request failed")}return res.json()}

async function loadRoster(){try{var data=await apiFetch(LIST_API);var entries=data.data||[];renderTable("pack-body",entries.filter(function(e){return e.data&&e.data.section==="pack-leadership"}));renderTable("den-body",entries.filter(function(e){return e.data&&e.data.section==="den-leaders"}));document.querySelector("#roster-count").textContent=entries.length+" role"+(entries.length===1?"":"s")}catch(e){document.querySelector("#roster-count").textContent="Could not load";showNotice("Failed to load roster: "+e.message,"error")}}

function renderTable(bodyId,entries){var tbody=document.querySelector("#"+bodyId);if(!entries.length){tbody.innerHTML='<tr><td colspan="4" class="empty"><strong>No roles yet</strong><span>Add a role to get started.</span></td></tr>';return}
tbody.innerHTML=entries.sort(function(a,b){return(a.data.sortOrder||0)-(b.data.sortOrder||0)}).map(function(e){var d=e.data||{};var nameHtml=d.name?esc(d.name):'<span class="vacant">Vacant</span>';return'<tr><td data-label="Role">'+esc(d.title)+'</td><td data-label="Name">'+nameHtml+'</td><td data-label="Order">'+(d.sortOrder||0)+'</td><td data-label="Actions"><div class="actions"><button class="btn-edit" data-id="'+esc(e.id)+'">Edit</button><button class="btn-delete" data-id="'+esc(e.id)+'" data-title="'+esc(d.title)+'">Delete</button></div></td></tr>'}).join("");Array.from(tbody.querySelectorAll(".btn-edit")).forEach(function(b){b.addEventListener("click",function(){openEdit(b.dataset.id)})});Array.from(tbody.querySelectorAll(".btn-delete")).forEach(function(b){b.addEventListener("click",function(){openDelete(b.dataset.id,b.dataset.title)})})}

function openModal(){document.querySelector("#modal-overlay").dataset.open="true";document.querySelector("#field-title").focus()}
function closeModal(){document.querySelector("#modal-overlay").dataset.open="false";document.querySelector("#entry-form").reset();document.querySelector("#entry-id").value=""}
function openDelete(id,title){document.querySelector("#delete-id").value=id;document.querySelector("#delete-message").textContent='Delete "'+title+'"? This cannot be undone.';document.querySelector("#delete-overlay").dataset.open="true"}
function closeDelete(){document.querySelector("#delete-overlay").dataset.open="false";document.querySelector("#delete-id").value=""}

async function openEdit(id){try{var data=await apiFetch(API_BASE+"/"+id);var d=data.data||{};document.querySelector("#entry-id").value=id;document.querySelector("#field-title").value=d.title||"";document.querySelector("#field-name").value=d.name||"";document.querySelector("#field-section").value=d.section||"pack-leadership";document.querySelector("#field-sortOrder").value=d.sortOrder||0;document.querySelector("#modal-title").textContent="Edit role";openModal()}catch(e){showNotice("Failed to load entry: "+e.message,"error")}}

document.querySelector("#add-entry").addEventListener("click",function(){document.querySelector("#entry-id").value="";document.querySelector("#entry-form").reset();document.querySelector("#field-sortOrder").value="0";document.querySelector("#modal-title").textContent="Add role";openModal()});
document.querySelector("#modal-cancel").addEventListener("click",closeModal);
document.querySelector("#delete-cancel").addEventListener("click",closeDelete);

document.querySelector("#entry-form").addEventListener("submit",async function(e){e.preventDefault();var id=document.querySelector("#entry-id").value;var payload={title:document.querySelector("#field-title").value,name:document.querySelector("#field-name").value,section:document.querySelector("#field-section").value,sortOrder:parseInt(document.querySelector("#field-sortOrder").value,10)||0};try{if(id){await apiFetch(API_BASE+"/"+id,{method:"PUT",body:JSON.stringify({data:payload})});showNotice("Role updated.","success")}else{await apiFetch(API_BASE+"/",{method:"POST",body:JSON.stringify({collection:COLLECTION,slug:payload.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""),title:payload.title,data:payload,status:"published"})});showNotice("Role added.","success")}closeModal();await loadRoster()}catch(err){showNotice("Failed to save: "+err.message,"error")}});

document.querySelector("#delete-confirm").addEventListener("click",async function(){var id=document.querySelector("#delete-id").value;if(!id)return;try{await apiFetch(API_BASE+"/"+id,{method:"DELETE"});showNotice("Role deleted.","success");closeDelete();await loadRoster()}catch(err){showNotice("Failed to delete: "+err.message,"error")}});

document.querySelector("#modal-overlay").addEventListener("click",function(e){if(e.target===e.currentTarget)closeModal()});
document.querySelector("#delete-overlay").addEventListener("click",function(e){if(e.target===e.currentTarget)closeDelete()});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeModal();closeDelete()}});

loadRoster();
${renderAdminHeaderScript()}
</script>
</body>
</html>`;
}
