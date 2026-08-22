function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  form { display: flex; flex-direction: column; gap: 0.75rem; max-width: 320px; }
  label { font-size: 0.9rem; }
  input[type=text], input[type=password], input[type=file] { padding: 0.5rem; font-size: 1rem; }
  button { padding: 0.6rem; font-size: 1rem; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; }
  .error { color: #b00020; }
  .nav a { margin-right: 1rem; }
  ul.server-list { list-style: none; padding: 0; }
  ul.server-list li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
</style>
</head>
<body>
${body}
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
  const nav = `<div class="nav">
    <span>Signed in as ${escapeHtml(admin.username)}</span> —
    ${admin.can_manage_accounts ? `<a href="/admin/accounts">Manage accounts</a> <a href="/admin/servers">Manage servers</a>` : ""}
    <a href="/logout">Sign out</a>
  </div>`;
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
  return layout("Dashboard — DCS Control Panel", `${nav}<h1>Your servers</h1>${list}`);
}

function accountsPage({ admin, accounts, servers, error, notice }) {
  const nav = `<div class="nav"><a href="/">Dashboard</a> <a href="/admin/servers">Manage servers</a> <a href="/logout">Sign out</a></div>`;
  // A <form> can't legally wrap a <tr>/<td> — browsers silently relocate or
  // drop it during HTML parsing, so checkboxes "inside" it never actually
  // belong to it and don't get submitted. Fix: one empty <form id="...">
  // per row, placed outside the table, with every input/button in that row
  // linked to it via the `form="..."` attribute instead of nesting.
  const forms = accounts
    .map((a) => `<form id="acct-${a.id}" method="post" action="/admin/accounts/${a.id}"></form>`)
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
    `${nav}
<h1>Admin accounts</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
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
</form>`
  );
}

function serversPage({ admin, servers, error, notice }) {
  const nav = `<div class="nav"><a href="/">Dashboard</a> <a href="/admin/accounts">Manage accounts</a> <a href="/logout">Sign out</a></div>`;
  // Same fix as accountsPage: a <form> can't legally wrap a <tr>, so each
  // row gets an out-of-band empty <form> plus `form="..."` on its inputs.
  const forms = servers.map((s) => `<form id="srv-${s.id}" method="post" action="/admin/servers/${s.id}"></form>`).join("");
  const rows = servers
    .map((s) => {
      const formId = `srv-${s.id}`;
      return `<tr>
        <td>${escapeHtml(s.slug)}</td>
        <td><input type="text" form="${formId}" name="name" value="${escapeHtml(s.name)}" required></td>
        <td><input type="text" form="${formId}" name="upstream_url" value="${escapeHtml(s.upstream_url)}" required></td>
        <td><input type="text" form="${formId}" name="mission_folder_key" value="${escapeHtml(s.mission_folder_key)}" required></td>
        <td>
          <button type="submit" form="${formId}">Save</button>
          <button form="${formId}" formaction="/admin/servers/${s.id}/delete">Delete</button>
        </td>
      </tr>`;
    })
    .join("");

  return layout(
    "Manage servers — DCS Control Panel",
    `${nav}
<h1>DCS servers</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
${forms}
<table>
  <thead><tr><th>Slug</th><th>Name</th><th>Upstream URL</th><th>Mission folder key</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p>Nobody has access to a server until you grant it from <a href="/admin/accounts">Manage accounts</a>. The mission folder key must match a <code>MISSION_FOLDER_&lt;KEY&gt;</code> env var configured on the physical host's mission-agent, or uploads to that server will fail.</p>
<h2>Add server</h2>
<form method="post" action="/admin/servers">
  <label>Slug (used in the URL, e.g. /s/training/) <input type="text" name="slug" pattern="[a-z0-9-]+" required></label>
  <label>Name <input type="text" name="name" required></label>
  <label>Upstream URL <input type="text" name="upstream_url" placeholder="http://10.0.1.10:8088" required></label>
  <label>Mission folder key <input type="text" name="mission_folder_key" pattern="[a-z0-9-]+" required></label>
  <button type="submit">Create server</button>
</form>`
  );
}

function missionsPage({ server, error, notice }) {
  const nav = `<div class="nav"><a href="/">Dashboard</a> <a href="/logout">Sign out</a></div>`;
  return layout(
    `Upload mission — ${server.name}`,
    `${nav}
<h1>Upload mission — ${escapeHtml(server.name)}</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
${notice ? `<p>${escapeHtml(notice)}</p>` : ""}
<form method="post" action="/s/${encodeURIComponent(server.slug)}/missions/upload" enctype="multipart/form-data">
  <label>Mission file (.miz) <input type="file" name="mission" accept=".miz" required></label>
  <button type="submit">Upload</button>
</form>`
  );
}

module.exports = { escapeHtml, loginPage, setupPage, dashboardPage, accountsPage, serversPage, missionsPage };
