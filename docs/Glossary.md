# Glossary

One term, one meaning, used the same way on every page.

**auth-gate**
The `src/server.js` process. Runs on the control-panel VM. Handles
login, access checks, and the control-port proxy.

**mission-agent**
The `src/agent.js` process. Runs on the physical host that runs DCS.
Handles mission files and reads the DCS control port directly.

**control port**
The DCS dedicated-server's own admin port. Accepts connections only
from 127.0.0.1 on its own machine.

**control-port proxy**
A shared listener inside the auth-gate. Relays an admin's browser
traffic to the right DCS server's control port, through the
mission-agent. See [Architecture](Architecture.md).

**control token**
A short-lived value minted per page load. Authorizes a control-port
proxy request in place of a cookie. See [Architecture](Architecture.md).

**slug**
A short text ID for one DCS server inside this app, for example
`main` or `server-2`. Set in `/admin/servers`. Used in URLs
(`/s/<slug>/`).

**instance_name**
The real folder name for one DCS server under `Saved Games` on the
physical host. Must match exactly. Set per server in `/admin/servers`.

**site admin**
An account with `can_manage_accounts`. Manages other accounts and
grants server access.

**per-server access**
A grant that lets one account reach one specific DCS server. Set per
admin, per server, in `/admin/accounts`.

**mission permission**
One of four separate grants per admin per server: upload, view,
download, delete. `view` gates reaching the missions page at all.

**A/B slot**
One of two parallel copies of the auth-gate's code on disk,
`releases/a/` and `releases/b/`. Self-update stages into the idle
slot, then flips to it.

**active slot**
Which A/B slot is live right now. Stored in a plain file, not the
database. See [Architecture](Architecture.md).

**flash cookie**
A one-shot cookie that carries a result message across a redirect, so
reloading the resulting page does not resubmit the form.

**webgui-static/**
The folder that holds a real copy of the DCS webgui's own files
(`index.html`, `app.js`, and so on). Not shipped in this repo. Each
deployment supplies its own copy.

**signed release**
A GitHub release carrying a `signed_updates.json` asset, signed with
this project's own private key. The auth-gate only applies a release
whose signature it can verify.
