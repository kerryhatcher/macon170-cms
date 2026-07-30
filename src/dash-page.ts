import {
  renderAdminHeader,
  renderAdminHeaderStyles,
  renderAdminHeaderScript,
} from "./admin-header";

export function renderDashPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Dashboard | Pack 170 CMS</title>
  <style>
    :root{color-scheme:light;--blue:#003f87;--deep:#002b5c;--gold:#fcd116;--ink:#272b2e;--muted:#5d6670;--paper:#fffdf5;--wash:#eef5fb;--rule:#ccd6e0;--green:#1f6b45;--red:#9b2c2c}
    *{box-sizing:border-box}body{margin:0;background:#f8f7f2;color:var(--ink);font:16px/1.5 system-ui,sans-serif}
    a{color:var(--blue)}button{font:inherit}.skip{position:absolute;left:-9999px}.skip:focus{left:1rem;top:1rem;background:#fff;padding:.75rem;z-index:10}
    ${renderAdminHeaderStyles()}
    main{max-width:1200px;margin:auto;padding:clamp(1.5rem,4vw,3rem)}
    .hero{margin-bottom:3rem}.hero h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.1;margin:0 0 .5rem}.hero p{color:var(--muted);font-size:1.1rem;max-width:50ch;margin:0}
    .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.5rem}
    .card{background:var(--paper);border:1px solid var(--rule);border-radius:8px 22px 12px 8px;padding:1.75rem;box-shadow:6px 8px 0 rgba(0,43,92,.08);transition:box-shadow .2s ease,transform .2s ease;text-decoration:none;color:inherit;display:grid;gap:.5rem}
    .card:hover{box-shadow:8px 10px 0 rgba(0,43,92,.14);transform:translate(-2px,-2px)}
    .card__icon{width:48px;height:48px;border-radius:12px;display:grid;place-items:center;font-size:1.5rem;margin-bottom:.25rem}
    .card__icon--blue{background:var(--wash);color:var(--blue)}
    .card__icon--gold{background:#fef5d6;color:#b8960a}
    .card__icon--green{background:#e8f4ec;color:var(--green)}
    .card h2{margin:0;font-size:1.25rem}
    .card p{margin:0;color:var(--muted);font-size:.95rem;line-height:1.45}
    .card .badge{display:inline-block;margin-top:.5rem;padding:.2rem .6rem;border-radius:999px;font-size:.78rem;font-weight:700;background:var(--wash);color:var(--blue)}
    .card .badge--green{background:#e8f4ec;color:var(--green)}
    .card .badge--gold{background:#fef5d6;color:#b8960a}
    .quick-links{margin-top:3rem;padding-top:2rem;border-top:2px solid var(--rule)}
    .quick-links h2{font-size:1.1rem;margin:0 0 1rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
    .quick-links nav{display:flex;flex-wrap:wrap;gap:.75rem}
    .quick-links a{display:inline-flex;align-items:center;gap:.5rem;padding:.6rem 1rem;background:var(--paper);border:1px solid var(--rule);border-radius:6px 14px 8px 6px;text-decoration:none;color:var(--ink);font-weight:600;font-size:.9rem;transition:box-shadow .15s ease}
    .quick-links a:hover{box-shadow:3px 4px 0 rgba(0,43,92,.1)}
    @media(max-width:700px){.cards{grid-template-columns:1fr}}
  </style>
</head>
<body>
<a class="skip" href="#main">Skip to dashboard</a>
${renderAdminHeader("dash")}
<main id="main">
  <div class="hero">
    <h1>Pack 170 CMS</h1>
    <p>Manage parent inquiries, calendar events, and site content from one place.</p>
  </div>
  <div class="cards">
    <a class="card" href="/admin/contact-form">
      <div class="card__icon card__icon--blue">&#9993;</div>
      <h2>Contact Form</h2>
      <p>Review and respond to parent inquiries. Track submissions by status and manage the volunteer queue.</p>
      <span class="badge" id="contact-count">Loading&hellip;</span>
    </a>
    <a class="card" href="/admin/calendar">
      <div class="card__icon card__icon--gold">&#128197;</div>
      <h2>Calendar</h2>
      <p>Create, edit, and publish pack events. Manage drafts, schedule changes, and keep families informed.</p>
      <span class="badge badge--gold" id="calendar-count">Loading&hellip;</span>
    </a>
    <a class="card" href="https://www.macon170.com" target="_blank" rel="noopener">
      <div class="card__icon card__icon--green">&#127758;</div>
      <h2>Public Site</h2>
      <p>View the live Pack 170 website as families see it. Opens in a new tab.</p>
      <span class="badge badge--green">macon170.com</span>
    </a>
  </div>
  <div class="quick-links">
    <h2>Quick links</h2>
    <nav>
      <a href="/admin/contact-form">&#9993; Contact queue</a>
      <a href="/admin/calendar">&#128197; Event editor</a>
      <a href="/auth/logout">&#10140; Sign out</a>
    </nav>
  </div>
</main>
<script>
${renderAdminHeaderScript()}
(async function(){try{const r=await fetch('/api/contact-admin/v1/submissions?page=1&status=pending');if(r.ok){const d=await r.json();const n=document.querySelector('#contact-count');if(n)n.textContent=d.submissions.length+' pending'+(d.submissions.length===1?'':'s')}}catch(e){const n=document.querySelector('#contact-count');if(n)n.textContent='Could not load'}})();
(async function(){try{const r=await fetch('/api/calendar-admin/v1/events');if(r.ok){const d=await r.json();const n=document.querySelector('#calendar-count');if(n){const p=d.events.filter(function(e){return e.publicationState==='published'}).length;n.textContent=p+' published event'+(p===1?'':'s')}}}catch(e){const n=document.querySelector('#calendar-count');if(n)n.textContent='Could not load'}})();
</script>
</body>
</html>`;
}
