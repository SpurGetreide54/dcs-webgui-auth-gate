// node's filesystem and path modules
const fs = require("node:fs");
const path = require("node:path");

const BRAND_NAME = process.env.BRAND_NAME || "DCS Auth Gate";
// the one deliberate exception to "views.js never touches the db"
// see docs/Why.md#why-does-viewsjs-read-the-db-for-the-update-icon
const updateCheck = require("./updateCheck");
const settings = require("./settings");

// escape a value for safe interpolation into html
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ICONS_DIR = path.join(PUBLIC_DIR, "icons");
const iconCache = new Map();

// read and cache one svg icon's markup, inlined rather than <img src>
// see docs/Why.md#why-are-icons-inlined-instead-of-referenced-via-img
function inlineIcon(filename, dir = ICONS_DIR) {
  const key = `${dir}/${filename}`;
  if (!iconCache.has(key)) {
    const raw = fs.readFileSync(path.join(dir, filename), "utf8").trim();
    // decorative, the accessible label travels separately
    iconCache.set(key, raw.replace("<svg ", '<svg aria-hidden="true" focusable="false" '));
  }
  return iconCache.get(key);
}

// render the real dcs webgui's own left-sidebar, icon-only nav
// the active item gets a blue left border
function sidebarNav(admin, active) {
  // the sr-only span carries the accessible name explicitly, title=
  // alone is inconsistently exposed to screen readers across browsers
  const navItem = (key, href, icon, label) =>
    `<li><a href="${href}" class="${key === active ? "active" : ""}" title="${escapeHtml(label)}">
      ${inlineIcon(icon)}<span class="sr-only">${escapeHtml(label)}</span>
    </a></li>`;

  const items = [navItem("dashboard", "/", "icon-dashboard.svg", "Dashboard")];
  // every admin gets a link here, either the full accounts page or
  // the read-only my-account page, see accountsPage() below
  items.push(
    admin.can_manage_accounts
      ? navItem("accounts", "/admin/accounts", "icon-manage-accounts.svg", "Manage accounts")
      : navItem("accounts", "/admin/accounts", "icon-user.svg", "My account")
  );
  if (admin.can_manage_accounts) {
    items.push(navItem("servers", "/admin/servers", "icon-server.svg", "Manage servers"));
    items.push(navItem("logs", "/admin/logs#latest", "icon-logs.svg", "View logs"));
    items.push(navItem("settings", "/admin/settings", "icon-settings.svg", "Settings"));
    const updateState = updateCheck.getUpdateState();
    const pinUpdateNav = settings.getSetting("pin_update_nav") === "1";
    if (updateState.available_version || pinUpdateNav) {
      const label = updateState.available_version ? `Update available: ${updateState.available_version}` : "Software update";
      items.push(navItem("update", "/admin/update", "icon-update.svg", label));
    }
  }

  return `<nav class="left-sidebar">
    <ul class="menu-items">${items.join("")}</ul>
  </nav>`;
}

// wrap a page body in the shared navbar, sidebar, and html shell
function layout(title, body, { admin, active, pageTitle } = {}) {
  const navbar = `<div class="navbar">
    <div class="navbar-brand">
      ${inlineIcon("logo.svg", PUBLIC_DIR)}
      <span class="brand-name">${escapeHtml(BRAND_NAME)}<span class="brand-tagline">Control Panel</span></span>
    </div>
    ${admin ? `<div class="navbar-right">
      <span>Signed in as ${escapeHtml(admin.username)}</span>
      <form method="post" action="/logout" class="logout-form">
        <button type="submit" class="destructive">Sign out</button>
      </form>
    </div>` : ""}
  </div>`;

  const main = admin
    ? `<div class="shell">
        ${sidebarNav(admin, active)}
        <main class="content">
          ${pageTitle ? `<div class="content-header"><h1>${escapeHtml(pageTitle)}</h1></div>` : ""}
          ${body}
        </main>
      </div>`
    : `<div class="login-shell"><div>${body}</div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/assets/logo.png">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
${navbar}
${main}
</body>
</html>`;
}

// the sign-in page
function loginPage({ error } = {}) {
  return layout(
    "Sign in — DCS Control Panel",
    `<h1>Sign in</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
  <label>Username <input type="text" name="username" required autofocus></label>
  <label>Password <input type="password" name="password" required></label>
  <button type="submit">Sign in</button>
</form>`
  );
}

// the one-time first-admin setup page
function setupPage({ error } = {}) {
  return layout(
    "First-time setup — DCS Control Panel",
    `<h1>Create the first admin account</h1>
<p>This page only works once. As soon as one admin account exists, it stops working.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/setup">
  <label>Username <input type="text" name="username" required autofocus></label>
  <label>Password <input type="password" name="password" required minlength="12"></label>
  <button type="submit">Create account</button>
</form>`
  );
}

// the logged-in admin's own list of accessible servers
function dashboardPage({ admin, servers }) {
  const list = servers.length
    ? `<ul class="server-list">${servers
        .map(
          (s) => `<li>
        <strong>${escapeHtml(s.name)}</strong>
        — <a href="/s/${encodeURIComponent(s.slug)}/">Open control panel</a>
        ${s.can_view_missions ? `— <a href="/s/${encodeURIComponent(s.slug)}/missions">Missions</a>` : ""}
      </li>`
        )
        .join("")}</ul>`
    : `<p>You don't have access to any servers yet. Ask a site admin to grant access.</p>`;
  return layout("Dashboard — DCS Control Panel", list, { admin, active: "dashboard", pageTitle: "Your servers" });
}

// section: the shared permissions matrix popup
// one per admin/invite row, opened at the click point
// see docs/Why.md#why-does-the-permissions-matrix-use-a-shared-popup

const PERMISSION_CATEGORIES = [
  { key: "access", label: "Access" },
  { key: "upload", label: "Upload" },
  { key: "view", label: "View" },
  { key: "download", label: "Download" },
  { key: "delete", label: "Delete" },
];

// turn a row's raw access grants into the popup's own flat shape
function permRowData(servers, access) {
  return servers.map((s) => {
    const grant = access.find((x) => x.server_id === s.id);
    return {
      server_id: s.id,
      access: Boolean(grant),
      upload: Boolean(grant && grant.can_upload_missions),
      view: Boolean(grant && grant.can_view_missions),
      download: Boolean(grant && grant.can_download_missions),
      delete: Boolean(grant && grant.can_delete_missions),
    };
  });
}

// render the button that opens the popup for one account or invite row
// kind is "account" or "invite", picking which endpoint a toggle posts to
function permButton(kind, id, servers, access) {
  const data = permRowData(servers, access);
  return `<button type="button" class="perm-btn" data-kind="${kind}" data-id="${id}" data-access="${escapeHtml(JSON.stringify(data))}">Permissions</button>`;
}

// render the one shared popup element plus the client script driving it
// filled in, each time, by whichever row's button was last clicked
function permPopupMarkup(servers) {
  const serversJson = JSON.stringify(servers.map((s) => ({ id: s.id, name: s.name }))).replace(/</g, "\\u003c");
  const categoriesJson = JSON.stringify(PERMISSION_CATEGORIES).replace(/</g, "\\u003c");
  return `<div id="perm-popup" class="perm-popup" hidden></div>
<script>
(function () {
  var SERVERS = ${serversJson};
  var CATEGORIES = ${categoriesJson};
  var popup = document.getElementById("perm-popup");

  function cellHtml(serverId, perm, granted) {
    return '<td class="perm-cell ' + (granted ? "granted" : "denied") + '" data-server-id="' + serverId + '" data-permission="' + perm + '">' +
      (granted ? "\\u2713" : "\\u2715") + "</td>";
  }

  function render(kind, id, rows) {
    var head = "<tr><th>Server</th>";
    CATEGORIES.forEach(function (c, i) {
      if (i === 1) head += '<th class="perm-group-gap"></th>';
      head += "<th>" + c.label + "</th>";
    });
    head += "</tr>";

    var body = SERVERS.map(function (server) {
      var row = rows.filter(function (r) { return r.server_id === server.id; })[0];
      var tds = "<td>" + server.name + "</td>";
      CATEGORIES.forEach(function (c, i) {
        if (i === 1) tds += '<td class="perm-group-gap"></td>';
        tds += cellHtml(server.id, c.key, row ? row[c.key] : false);
      });
      return "<tr>" + tds + "</tr>";
    }).join("");

    popup.innerHTML = "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>" +
      '<button type="button" class="perm-close">Close</button>';
    popup.querySelector(".perm-close").addEventListener("click", hide);
    Array.prototype.forEach.call(popup.querySelectorAll(".perm-cell"), function (cell) {
      cell.addEventListener("click", function () { toggle(kind, id, cell); });
    });
  }

  function setCell(cell, granted) {
    cell.classList.toggle("granted", granted);
    cell.classList.toggle("denied", !granted);
    cell.textContent = granted ? "\\u2713" : "\\u2715";
  }

  function toggle(kind, id, cell) {
    var serverId = Number(cell.getAttribute("data-server-id"));
    var permission = cell.getAttribute("data-permission");
    var granted = !cell.classList.contains("granted");
    setCell(cell, granted);
    // turning access off visually clears every other cell in the row
    // too, the server is what's actually authoritative, this just mirrors it
    if (permission === "access" && !granted) {
      Array.prototype.forEach.call(popup.querySelectorAll('.perm-cell[data-server-id="' + serverId + '"]'), function (c) { setCell(c, false); });
    }
    var url = (kind === "invite" ? "/admin/accounts/invites/" : "/admin/accounts/") + id + "/permissions";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: serverId, permission: permission, granted: granted }),
    }).then(function (res) {
      if (!res.ok) throw new Error("request failed");
    }).catch(function () {
      setCell(cell, !granted);
    });
  }

  function hide() { popup.hidden = true; }

  Array.prototype.forEach.call(document.querySelectorAll(".perm-btn"), function (btn) {
    btn.addEventListener("click", function (e) {
      render(btn.getAttribute("data-kind"), btn.getAttribute("data-id"), JSON.parse(btn.getAttribute("data-access")));
      popup.hidden = false;
      var rect = popup.getBoundingClientRect();
      var x = Math.min(Math.max(12, e.clientX), window.innerWidth - rect.width - 12);
      var y = Math.min(Math.max(12, e.clientY), window.innerHeight - rect.height - 12);
      popup.style.left = x + "px";
      popup.style.top = y + "px";
      e.stopPropagation();
    });
  });
  document.addEventListener("click", function (e) {
    if (!popup.hidden && !popup.contains(e.target) && !e.target.classList.contains("perm-btn")) hide();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hide();
  });
})();
</script>`;
}

// the change-password form, shared by the site-admin and my-account pages
function changePasswordSection() {
  return `<h2>Change password</h2>
<form method="post" action="/admin/accounts/change-password">
  <label>Current password <input type="password" name="current_password" required></label>
  <label>New password <input type="password" name="new_password" required minlength="12"></label>
  <label>Confirm new password <input type="password" name="confirm_password" required minlength="12"></label>
  <button type="submit" class="destructive">Change password</button>
</form>`;
}

// the just-created invite link, with a copy button
function inviteLinkNotice(inviteUrl) {
  if (!inviteUrl) return "";
  const safeUrl = escapeHtml(inviteUrl);
  return `<p class="invite-notice">
  Invite link: <a href="${safeUrl}" class="invite-link" data-copy="${safeUrl}">${safeUrl}</a>
  <button type="button" class="invite-copy" data-copy="${safeUrl}">Copy</button>
</p>
<script>
(function () {
  document.querySelectorAll("[data-copy]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      navigator.clipboard.writeText(el.getAttribute("data-copy"));
    });
  });
})();
</script>`;
}

// the full account roster plus creation, for admins who can manage accounts
// everyone else gets myAccountPage() below instead, see accountsPage()
function siteAdminAccountsPage({ admin, accounts, servers, invites, error, notice, inviteUrl }) {
  // each row gets its own out-of-band form instead of wrapping the
  // row, see docs/Why.md#why-does-each-table-row-get-its-own-out-of-band-form
  const acctForms = accounts
    .map((a) => `<form id="acct-${a.id}" class="row-form" method="post" action="/admin/accounts/${a.id}"></form>`)
    .join("");
  const inviteForms = invites
    .map((inv) => `<form id="inv-${inv.id}" class="row-form" method="post" action="/admin/accounts/invites/${inv.id}"></form>`)
    .join("");

  const acctRows = accounts
    .map((a) => {
      const formId = `acct-${a.id}`;
      return `<tr>
        <td>${escapeHtml(a.username)}</td>
        <td><input type="checkbox" form="${formId}" name="can_manage_accounts" ${a.can_manage_accounts ? "checked" : ""}></td>
        <td>${permButton("account", a.id, servers, a.access)}</td>
        <td>
          <button type="submit" form="${formId}">Save</button>
          ${accounts.length > 1 ? `<button form="${formId}" formaction="/admin/accounts/${a.id}/delete" class="destructive">Delete</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  const inviteRows = invites
    .map((inv) => {
      const formId = `inv-${inv.id}`;
      // expires_at is sqlite's own "yyyy-mm-dd hh:mm:ss" in utc, just
      // the time is enough context for a 30 minute lived row
      const expiresLabel = inv.expires_at.slice(11, 16);
      return `<tr class="pending-invite">
        <td><em>${escapeHtml(inv.token_prefix)}&hellip; <span class="pending-label">(pending, expires ${escapeHtml(expiresLabel)} UTC)</span></em></td>
        <td><input type="checkbox" form="${formId}" name="can_manage_accounts" ${inv.can_manage_accounts ? "checked" : ""}></td>
        <td>${permButton("invite", inv.id, servers, inv.access)}</td>
        <td>
          <button type="submit" form="${formId}">Save</button>
          <button form="${formId}" formaction="/admin/accounts/invites/${inv.id}/revoke" class="destructive">Revoke</button>
        </td>
      </tr>`;
    })
    .join("");

  return layout(
    "Manage accounts — DCS Control Panel",
    `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
${inviteLinkNotice(inviteUrl)}
${acctForms}${inviteForms}
<table>
  <thead><tr><th>Username</th><th>Site admin</th><th>Permissions</th><th></th></tr></thead>
  <tbody>${acctRows}${inviteRows}</tbody>
</table>
<h2>Add account</h2>
<p>A new account starts with no server access. Grant it from its own Permissions button in the table above, right after creating it.</p>
<div class="account-create">
  <input type="checkbox" id="mode-invite" class="mode-toggle-input">
  <label for="mode-invite" class="mode-switch-row">
    <span class="mode-switch-text-fixed">Fixed</span>
    <span class="mode-switch-track"><span class="mode-switch-thumb"></span></span>
    <span class="mode-switch-text-invite">Invite link</span>
  </label>
  <form method="post" action="/admin/accounts" class="create-form create-form-fixed">
    <label>Username <input type="text" name="username" required></label>
    <label>Password <input type="password" name="password" required minlength="12"></label>
    <label><input type="checkbox" name="can_manage_accounts"> Site admin (can manage accounts)</label>
    <button type="submit">Create account</button>
  </form>
  <form method="post" action="/admin/accounts/invite" class="create-form create-form-invite">
    <label><input type="checkbox" name="can_manage_accounts"> Site admin (can manage accounts)</label>
    <button type="submit">Generate invite link</button>
  </form>
</div>
${changePasswordSection()}
${permPopupMarkup(servers)}`,
    { admin, active: "accounts", pageTitle: "Admin accounts" }
  );
}

// a non-site-admin's own row only, read-only, plus their own password change
function myAccountPage({ admin, own, servers, error, notice }) {
  const cells = servers
    .map((s) => {
      const grant = own.access.find((x) => x.server_id === s.id);
      return `<td>
          <label><input type="checkbox" disabled ${grant ? "checked" : ""}> access</label><br>
          <label><input type="checkbox" disabled ${grant && grant.can_upload_missions ? "checked" : ""}> upload</label><br>
          <label><input type="checkbox" disabled ${grant && grant.can_view_missions ? "checked" : ""}> view</label><br>
          <label><input type="checkbox" disabled ${grant && grant.can_download_missions ? "checked" : ""}> download</label><br>
          <label><input type="checkbox" disabled ${grant && grant.can_delete_missions ? "checked" : ""}> delete</label>
        </td>`;
    })
    .join("");
  const header = servers.map((s) => `<th>${escapeHtml(s.name)}</th>`).join("");

  return layout(
    "My account — DCS Control Panel",
    `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
<table>
  <thead><tr><th>Username</th>${header}</tr></thead>
  <tbody><tr><td>${escapeHtml(own.username)}</td>${cells}</tr></tbody>
</table>
${changePasswordSection()}`,
    { admin, active: "accounts", pageTitle: "My account" }
  );
}

// pick the right accounts page for this admin's own role
function accountsPage(data) {
  return data.admin.can_manage_accounts ? siteAdminAccountsPage(data) : myAccountPage(data);
}

// the invite-link landing page, where a new account is actually created
function invitePage({ error } = {}) {
  return layout(
    "Accept invite — DCS Control Panel",
    `<h1>Create your account</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post">
  <label>Username <input type="text" name="username" required autofocus></label>
  <label>Password <input type="password" name="password" required minlength="12"></label>
  <label>Confirm password <input type="password" name="confirm_password" required minlength="12"></label>
  <button type="submit">Create account</button>
</form>`
  );
}

// shown when an invite link is unknown or past its 30 minute window
function inviteExpiredPage() {
  return layout(
    "Invite expired — DCS Control Panel",
    `<h1>This invite link is invalid or has expired</h1>
<p>Ask a site admin for a new one.</p>`
  );
}

// the site-admin server roster, editable, plus server creation
function serversPage({ admin, servers, error, notice }) {
  // each row gets its own out-of-band form, same fix as accountsPage
  // see docs/Why.md#why-does-each-table-row-get-its-own-out-of-band-form
  const forms = servers.map((s) => `<form id="srv-${s.id}" class="row-form" method="post" action="/admin/servers/${s.id}"></form>`).join("");
  const rows = servers
    .map((s) => {
      const formId = `srv-${s.id}`;
      return `<tr>
        <td>${escapeHtml(s.slug)}</td>
        <td><input type="text" form="${formId}" name="name" value="${escapeHtml(s.name)}" required></td>
        <td><input type="text" form="${formId}" name="instance_name" value="${escapeHtml(s.instance_name)}" required></td>
        <td><input type="text" form="${formId}" name="dcs_install_path" value="${escapeHtml(s.dcs_install_path || "")}" placeholder="e.g. C:\\Program Files\\Eagle Dynamics\\DCS World Server"></td>
        <td>
          <button type="submit" form="${formId}">Save</button>
          <button form="${formId}" formaction="/admin/servers/${s.id}/delete">Delete</button>
        </td>
      </tr>`;
    })
    .join("");

  return layout(
    "Manage servers — DCS Control Panel",
    `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
${forms}
<table>
  <thead><tr><th>Slug</th><th>Name</th><th>DCS instance name</th><th>DCS install path</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p>Nobody has access to a server until you grant it from <a href="/admin/accounts">Manage accounts</a>. The DCS instance name must match the real instance folder name under <code>Saved Games</code> on the physical host, or the webgui and mission uploads won't find it. <a href="/admin/servers/webgui-ports">Review/assign webgui control ports</a> once servers are added.</p>
<p>DCS install path is optional — it's the root folder of a DCS World Server install on this server's host (not the <code>WebGUI</code> folder itself), and only matters if you want this server offered as a source on the <a href="/admin/servers/webgui-sync">webgui sync</a> page.</p>
<h2>Add server</h2>
<form method="post" action="/admin/servers">
  <label>Slug (used in the URL, e.g. /s/training/) <input type="text" name="slug" pattern="[a-z0-9-]+" required></label>
  <label>Name <input type="text" name="name" required></label>
  <label>DCS instance name <input type="text" name="instance_name" pattern="(?!\.+$)[A-Za-z0-9_.-]+" value="DCS.dcs_serverrelease" required></label>
  <label>DCS install path (optional) <input type="text" name="dcs_install_path" placeholder="e.g. C:\\Program Files\\Eagle Dynamics\\DCS World Server"></label>
  <button type="submit">Create server</button>
</form>`,
    { admin, active: "servers", pageTitle: "DCS servers" }
  );
}

// confirm-before-write page for assigning missing webgui control ports
function webguiPortsPage({ admin, proposals }) {
  const rows = proposals
    .map((p) => `<tr><td>${escapeHtml(p.server.name)}</td><td>${escapeHtml(p.server.instance_name)}</td><td>${p.proposedPort}</td></tr>`)
    .join("");

  const body =
    proposals.length === 0
      ? `<p>Every configured server already has a webgui control port. Nothing to do.</p>`
      : `<p>These servers have no <code>webgui_port</code> in their <code>Config\\autoexec.cfg</code> yet. Confirming will create or append that line on the physical host via the mission-agent — existing config content is preserved either way.</p>
<table>
  <thead><tr><th>Server</th><th>Instance</th><th>Proposed port</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<form method="post" action="/admin/servers/webgui-ports/confirm">
  <button type="submit">Confirm and assign these ports</button>
</form>`;

  return layout(`Webgui ports — DCS Control Panel`, body, { admin, active: "servers", pageTitle: "Assign webgui control ports" });
}

// confirm-before-write page for replacing webgui-static/ from a real install
function webguiSyncPage({ admin, servers, error, notice }) {
  const withPath = servers.filter((s) => s.dcs_install_path);
  const options = withPath
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.dcs_install_path)})</option>`)
    .join("");

  const body = `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
<p>Pulls the real webgui SPA straight out of a DCS World Server install already on the host (<code>&lt;install path&gt;\\WebGUI</code>) and replaces <code>webgui-static/</code> with it — no manual copying needed. This fully replaces the currently-served bundle for every server; it's used to serve <code>/s/&lt;slug&gt;/</code> for all of them, not just the one picked below.</p>
${
  withPath.length === 0
    ? `<p>No server has a DCS install path set yet. Add one from <a href="/admin/servers">Manage servers</a> first.</p>`
    : `<form method="post" action="/admin/servers/webgui-sync/confirm">
  <label>Sync from
    <select name="server_id" required>${options}</select>
  </label>
  <button type="submit">Sync webgui-static/ now</button>
</form>`
}`;

  return layout("Sync webgui — DCS Control Panel", body, { admin, active: "servers", pageTitle: "Sync webgui bundle" });
}

// human-readable file size
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

// the mission table, selection checkboxes shared by download and delete
function missionListSection(server, access, missions) {
  const slug = encodeURIComponent(server.slug);
  const canSelect = access.canDownload || access.canDelete;
  const colCount = 3 + (canSelect ? 1 : 0);

  // download is the shared form's default action, delete overrides
  // it via formaction on that one button, same trick as the accounts table
  const rows = missions.length
    ? missions
        .map(
          (m) => `<tr>
        ${canSelect ? `<td class="mission-select"><input type="checkbox" form="mission-form" name="mission" value="${escapeHtml(m.name)}"></td>` : ""}
        <td>${escapeHtml(m.name)}</td>
        <td class="mission-size">${formatBytes(m.size)}</td>
        <td class="mission-date">${escapeHtml(m.modifiedAt.slice(0, 16).replace("T", " "))}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="${colCount}">No missions on this server yet.</td></tr>`;

  const actions = [
    access.canDownload ? `<button type="submit" form="mission-form">Download selected</button>` : "",
    access.canDelete ? `<button type="submit" form="mission-form" formaction="/s/${slug}/missions/trash" class="destructive">Delete selected</button>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `<h2>Missions</h2>
${canSelect ? `<form id="mission-form" class="row-form" method="post" action="/s/${slug}/missions/${access.canDownload ? "download" : "trash"}"></form>` : ""}
<table>
  <thead><tr>
    ${canSelect ? "<th></th>" : ""}
    <th>Name</th><th>Size</th><th>Modified</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${actions ? `<div class="mission-actions">${actions}</div>` : ""}`;
}

// a server's mission list plus its own upload form, per-permission
function missionsPage({ admin, server, access = {}, missions = [], error, notice }) {
  const uploadForm = access.canUpload
    ? `<h2>Upload mission</h2>
<form method="post" action="/s/${encodeURIComponent(server.slug)}/missions/upload" enctype="multipart/form-data">
  <label>Mission file (.miz) <input type="file" name="mission" accept=".miz" required></label>
  <button type="submit">Upload</button>
</form>`
    : "";

  return layout(
    `Missions — ${server.name}`,
    `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
${access.canView ? missionListSection(server, access, missions) : ""}
${uploadForm}`,
    { admin, active: "dashboard", pageTitle: `Missions — ${server.name}` }
  );
}

// the software-update tab: current version, last check, update button
function updatePage({ admin, currentVersion, updateState, error, notice }) {
  const hasUpdate = Boolean(updateState.available_version);
  const checkedLabel = updateState.last_checked_at ? `${updateState.last_checked_at.slice(0, 16).replace("T", " ")} UTC` : "never";

  const body = `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
<p>Running version <strong>${escapeHtml(currentVersion)}</strong>. Last checked: ${escapeHtml(checkedLabel)}.</p>
<form method="post" action="/admin/update/check">
  <button type="submit">Check now</button>
</form>
${
  hasUpdate
    ? `<p>A new version is available: <strong>${escapeHtml(updateState.available_version)}</strong>. <a href="${escapeHtml(updateState.changelog_url || "")}" target="_blank" rel="noopener">Changelog</a></p>
${updateState.needs_service_update ? `<p class="error">This release needs a manual service-config change (systemd unit / NSSM install.ps1) before or after updating — check the changelog for specifics. The A/B swap alone can't apply it.</p>` : ""}
<form method="post" action="/admin/update">
  <p>Updates both this auth-gate and the mission-agent, staged into the idle slot, then restarts into it. Rolls back automatically on crash.</p>
  <button type="submit">Update now</button>
</form>`
    : `<p>You're running the latest version. Checked automatically once an hour.</p>`
}`;

  return layout("Update — DCS Control Panel", body, { admin, active: "update", pageTitle: "Software update" });
}

// the one site-wide settings toggle page
function settingsPage({ admin, pinUpdateNav, error, notice }) {
  const body = `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
<form method="post" action="/admin/settings">
  <label><input type="checkbox" name="pin_update_nav" value="1" ${pinUpdateNav ? "checked" : ""}> Always show Update in the sidebar</label>
  <button type="submit">Save</button>
</form>`;

  return layout("Settings — DCS Control Panel", body, { admin, active: "settings", pageTitle: "Settings" });
}

const LOG_WINDOW_LABELS = { "15m": "Last 15 minutes", "1h": "Last hour", "6h": "Last 6 hours", "24h": "Last 24 hours", all: "All" };

// the merged auth-gate/agent log timeline, oldest at top like a chat
// see docs/Why.md#why-does-the-logs-page-merge-both-sources-into-one-timeline
function logsPage({ admin, entries, agentError, filters }) {
  const { sources, since, verbose } = filters;

  const filterForm = `<form method="get" action="/admin/logs#latest" class="log-filters">
  <div class="log-filter-group">
    <label><input type="checkbox" name="source" value="app" ${sources.has("app") ? "checked" : ""}> Auth-gate</label>
    <label><input type="checkbox" name="source" value="agent" ${sources.has("agent") ? "checked" : ""}> Agent</label>
  </div>
  <div class="log-filter-group">
    <label>Since
      <select name="since">
        ${Object.entries(LOG_WINDOW_LABELS)
          .map(([key, label]) => `<option value="${key}" ${since === key ? "selected" : ""}>${escapeHtml(label)}</option>`)
          .join("")}
      </select>
    </label>
  </div>
  <div class="log-filter-group">
    <label title="Step-by-step detail, e.g. each stage of a self-update — hidden by default, since it's only useful when something's actually stuck.">
      <input type="checkbox" name="verbose" value="1" ${verbose ? "checked" : ""}> Verbose
    </label>
  </div>
  <button type="submit">Apply filters</button>
</form>`;

  const rows = entries.length
    ? entries
        .map((e) => {
          const time = e.t ? escapeHtml(e.t.replace("T", " ").slice(0, 19)) : "";
          const sourceLabel = e.source === "agent" ? "agent" : "auth-gate";
          return `<div class="log-row level-${escapeHtml(e.level)}">
    <span class="log-time">${time}</span>
    <span class="log-badge source-${escapeHtml(e.source)}">${escapeHtml(sourceLabel)}</span>
    <span class="log-msg">${escapeHtml(e.msg)}</span>
  </div>`;
        })
        .join("")
    : `<p>No log entries match the current filters.</p>`;

  const body = `${agentError ? `<p class="error">${escapeHtml(agentError)}</p>` : ""}
${filterForm}
<div class="log-entries">
  ${rows}
  <a id="latest"></a>
</div>
<p><a href="/admin/logs#latest">Refresh</a></p>`;

  return layout("Logs — DCS Control Panel", body, { admin, active: "logs", pageTitle: "Logs" });
}

// expose every page-render function and the shared escaper to callers
module.exports = {
  escapeHtml,
  loginPage,
  setupPage,
  dashboardPage,
  accountsPage,
  invitePage,
  inviteExpiredPage,
  serversPage,
  webguiPortsPage,
  webguiSyncPage,
  missionsPage,
  updatePage,
  settingsPage,
  logsPage,
};
