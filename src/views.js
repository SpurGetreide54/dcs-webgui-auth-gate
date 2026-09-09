const BRAND_NAME = process.env.BRAND_NAME || "DCS Auth Gate";

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// Mirrors the real DCS webgui's own left-sidebar. Icon-only nav. Active
// item gets a blue left border. Sign-out is pinned to the bottom via a
// second <ul>.
function sidebarNav(admin, active) {
  const navItem = (key, href, icon, label) =>
    `<li><a href="${href}" class="${key === active ? "active" : ""}" title="${escapeHtml(label)}">
      <img src="/assets/icons/${icon}" alt="${escapeHtml(label)}">
    </a></li>`;

  const items = [navItem("dashboard", "/", "icon-dashboard.png", "Dashboard")];
  if (admin.can_manage_accounts) {
    items.push(navItem("accounts", "/admin/accounts", "icon-user.png", "Manage accounts"));
    items.push(navItem("servers", "/admin/servers", "icon-server.png", "Manage servers"));
  }

  return `<nav class="left-sidebar">
    <ul class="menu-items">${items.join("")}</ul>
    <ul class="menu-items">${navItem("logout", "/logout", "icon-close.png", "Sign out")}</ul>
  </nav>`;
}

function layout(title, body, { admin, active, pageTitle } = {}) {
  const navbar = `<div class="navbar">
    <div class="navbar-brand">
      <img src="/assets/logo.png" alt="">
      <span class="brand-name">${escapeHtml(BRAND_NAME)}<span class="brand-tagline">Control Panel</span></span>
    </div>
    ${admin ? `<div class="navbar-right">Signed in as ${escapeHtml(admin.username)}</div>` : ""}
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

function dashboardPage({ admin, servers }) {
  const list = servers.length
    ? `<ul class="server-list">${servers
        .map(
          (s) => `<li>
        <strong>${escapeHtml(s.name)}</strong>
        — <a href="/s/${encodeURIComponent(s.slug)}/">Open control panel</a>
        ${s.can_upload_missions ? `— <a href="/s/${encodeURIComponent(s.slug)}/missions">Upload mission</a>` : ""}
      </li>`
        )
        .join("")}</ul>`
    : `<p>You don't have access to any servers yet. Ask a site admin to grant access.</p>`;
  return layout("Dashboard — DCS Control Panel", list, { admin, active: "dashboard", pageTitle: "Your servers" });
}

function accountsPage({ admin, accounts, servers, error, notice }) {
  // A <form> can't legally wrap a <tr>/<td>. Browsers silently relocate or
  // drop it during HTML parsing, so checkboxes "inside" it never actually
  // belong to it and don't get submitted. Fix: one empty <form id="..."> per
  // row, placed outside the table, with every input/button in that row
  // linked to it via the `form="..."` attribute instead of nesting.
  const forms = accounts
    .map((a) => `<form id="acct-${a.id}" class="row-form" method="post" action="/admin/accounts/${a.id}"></form>`)
    .join("");
  const rows = accounts
    .map((a) => {
      const formId = `acct-${a.id}`;
      const cells = servers
        .map((s) => {
          const access = a.access.find((x) => x.server_id === s.id);
          const checked = access ? "checked" : "";
          const uploadChecked = access && access.can_upload_missions ? "checked" : "";
          return `<td>
          <label><input type="checkbox" form="${formId}" name="access_${s.id}" ${checked}> access</label><br>
          <label><input type="checkbox" form="${formId}" name="upload_${s.id}" ${uploadChecked}> upload</label>
        </td>`;
        })
        .join("");
      return `<tr>
        <td>${escapeHtml(a.username)}</td>
        <td><input type="checkbox" form="${formId}" name="can_manage_accounts" ${a.can_manage_accounts ? "checked" : ""}></td>
        ${cells}
        <td>
          <button type="submit" form="${formId}">Save</button>
          ${accounts.length > 1 ? `<button form="${formId}" formaction="/admin/accounts/${a.id}/delete">Delete</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");
  const header = servers.map((s) => `<th>${escapeHtml(s.name)}</th>`).join("");

  return layout(
    "Manage accounts — DCS Control Panel",
    `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
${forms}
<table>
  <thead><tr><th>Username</th><th>Site admin</th>${header}<th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<h2>Add account</h2>
<form method="post" action="/admin/accounts">
  <label>Username <input type="text" name="username" required></label>
  <label>Password <input type="password" name="password" required minlength="12"></label>
  <label><input type="checkbox" name="can_manage_accounts"> Site admin (can manage accounts)</label>
  ${servers
    .map(
      (s) => `<fieldset>
      <legend>${escapeHtml(s.name)}</legend>
      <label><input type="checkbox" name="access_${s.id}"> Access</label>
      <label><input type="checkbox" name="upload_${s.id}"> Can upload missions</label>
    </fieldset>`
    )
    .join("")}
  <button type="submit">Create account</button>
</form>`,
    { admin, active: "accounts", pageTitle: "Admin accounts" }
  );
}

function serversPage({ admin, servers, error, notice }) {
  // Same fix as accountsPage. A <form> can't legally wrap a <tr>, so each
  // row gets an out-of-band empty <form> plus `form="..."` on its inputs.
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

function missionsPage({ admin, server, error, notice }) {
  return layout(
    `Upload mission — ${server.name}`,
    `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
<form method="post" action="/s/${encodeURIComponent(server.slug)}/missions/upload" enctype="multipart/form-data">
  <label>Mission file (.miz) <input type="file" name="mission" accept=".miz" required></label>
  <button type="submit">Upload</button>
</form>`,
    { admin, active: "dashboard", pageTitle: `Upload mission — ${server.name}` }
  );
}

module.exports = {
  escapeHtml,
  loginPage,
  setupPage,
  dashboardPage,
  accountsPage,
  serversPage,
  webguiPortsPage,
  webguiSyncPage,
  missionsPage,
};
