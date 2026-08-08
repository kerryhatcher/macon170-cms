/**
 * Shared admin header rendered throughout the Pack CMS workspace.
 * Mirrors the public site's SiteHeader design: deep blue background, gold bottom
 * border, round logo badge, Montserrat nav links, and a mobile hamburger menu.
 */

export type AdminPage =
  | "dash"
  | "leadership"
  | "contact-form"
  | "calendar"
  | "signups";

export function renderAdminHeader(currentPage: AdminPage): string {
  const links: Array<{ href: string; label: string; page: AdminPage }> = [
    { href: "/dash", label: "Dashboard", page: "dash" },
    { href: "/admin/leadership", label: "Leadership", page: "leadership" },
    { href: "/admin/contact-form", label: "Contact Form", page: "contact-form" },
    { href: "/admin/calendar", label: "Calendar", page: "calendar" },
    { href: "/admin/signups", label: "Signups", page: "signups" },
  ];

  const navItems = links
    .map(
      (link) =>
        `<a href="${link.href}"${link.page === currentPage ? ' aria-current="page"' : ""}>${link.label}</a>`,
    )
    .join("");

  return `<header class="admin-header">
  <div class="admin-header__shell">
    <a class="admin-header__brand" href="/dash" aria-label="Pack 170 CMS home">
      <img class="admin-header__logo" src="https://www.macon170.com/logo/pack170-logo-256.webp" width="256" height="256" alt="" aria-hidden="true" />
      <span>Pack <span style="color:var(--gold)">170</span> <small>CMS</small></span>
    </a>
    <button class="admin-header__toggle" type="button" aria-expanded="false" aria-controls="admin-nav">Menu</button>
    <nav class="admin-header__nav" id="admin-nav" aria-label="Admin navigation">${navItems}</nav>
  </div>
</header>`;
}

export function renderAdminHeaderStyles(): string {
  return `
.admin-header{position:relative;z-index:20;background:var(--deep);color:#fff;border-bottom:5px solid var(--gold)}
.admin-header__shell{max-width:1200px;margin-inline:auto;min-height:72px;display:flex;align-items:center;gap:2rem;padding:0 clamp(1rem,4vw,3rem)}
.admin-header__brand{display:flex;align-items:center;gap:.8rem;color:#fff;text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-weight:900;letter-spacing:-.02em;white-space:nowrap}
.admin-header__brand small{font-weight:600;font-size:.7em;opacity:.75}
.admin-header__logo{width:44px;height:auto;aspect-ratio:1;border-radius:50%}
.admin-header__nav{margin-left:auto;display:flex;align-items:stretch;align-self:stretch}
.admin-header__nav a{display:flex;align-items:center;padding:0 .85rem;color:var(--blue-soft,#b8cce0);text-decoration:none;font-family:Montserrat,Arial,sans-serif;font-size:.83rem;font-weight:700}
.admin-header__nav a[aria-current="page"]{background:rgba(255,255,255,.1);color:#fff}
@media(hover:hover){.admin-header__nav a:hover{background:rgba(255,255,255,.1);color:#fff}}
.admin-header__toggle{display:none;margin-left:auto;border:2px solid rgba(255,255,255,.65);background:transparent;color:#fff;min-width:48px;min-height:48px;border-radius:8px;font-weight:700;font:inherit;cursor:pointer}
@media(max-width:800px){.admin-header__toggle{display:block}
.admin-header__nav{display:none;position:absolute;top:72px;left:0;right:0;padding:1rem;background:var(--deep);box-shadow:0 14px 24px rgba(0,0,0,.25);flex-direction:column}
.admin-header__nav[data-open="true"]{display:flex}
.admin-header__nav a,.admin-header__nav a.nav-priority{min-height:50px;margin:0;padding:.7rem 1rem;border-radius:4px}}
`;
}

export function renderAdminHeaderScript(): string {
  return `
(function(){var t=document.querySelector('.admin-header__toggle'),n=document.querySelector('#admin-nav');function o(o){t&&t.setAttribute('aria-expanded',String(o));n&&n.setAttribute('data-open',String(o))}t&&t.addEventListener('click',function(){o(t.getAttribute('aria-expanded')!=='true')});document.addEventListener('click',function(e){var r=e.target;if(!t||t.getAttribute('aria-expanded')!=='true')return;if(t.contains(r)||n&&n.contains(r))return;o(false)});document.addEventListener('keydown',function(e){if(e.key!=='Escape'||!t||t.getAttribute('aria-expanded')!=='true')return;o(false);t&&t.focus()})})();
`;
}
