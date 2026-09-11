# DCS Webgui Auth Gate

DCS World is a combat flight simulator. People run private multiplayer
game servers for it. Each DCS dedicated-server install ships its own
admin control panel — a small web app from Eagle Dynamics for managing
that one server: missions, players, and so on.

That control panel talks to the game server through a "control port". The
control port only accepts connections from the server's own machine
(127.0.0.1). Out of the box, only someone logged into that exact machine
can reach it.

This project puts a gate in front of that control panel. It lets several
admins reach the panel securely from anywhere, without exposing the
control port to the open internet. Each admin gets their own login and
their own scoped access: which server they can see, and whether they can
upload missions to it. One deployment can front several DCS servers at
once.

This repo does not include the real control panel's own files
(`index.html`, `app.js`, and so on) — that code belongs to Eagle
Dynamics. A deployer supplies their own legitimate copy, either by hand
(copy it into `webgui-static/`) or by pulling it live from a real DCS
install through `/admin/servers/webgui-sync`.

## Two processes, one repo

- **`src/server.js`** (`npm start`) — the auth-gate. Deploy it on a
  control-panel VM, reachable from the internet behind a reverse proxy
  (see the sibling `dcs-webgui-reverse-proxy` repo). It serves the real
  control panel as a static bundle under `webgui-static/`, gated behind
  login and per-server access checks. It also runs a second listener in
  the same process: a shared control-port proxy that relays each admin's
  panel traffic to the right DCS server.
- **`src/agent.js`** (`npm run agent`) — a small relay agent. Deploy it on
  the physical host, next to the DCS gameservers — the only machine that
  can reach a control port directly. It accepts `.miz` mission-file
  uploads into a server's mission folder, reads and writes the server's
  `autoexec.cfg` to check and assign its webgui port, relays control-port
  traffic from the auth-gate, and can read and tar up a DCS install's
  WebGUI folder for `webgui-sync`. A shared token authenticates it. It has
  no accounts, no login, and no delete access to anything — see the
  comments in that file for why.

## Two admin roles

- **Site admin** (`can_manage_accounts`): manages other admin accounts and
  decides who gets access to which server.
- **Per-server access + upload** (`admin_server_access`): a site admin
  grants each admin access to specific servers individually, and,
  separately, whether they can upload missions on each one. Access to one
  server says nothing about any other.

## More docs

- [`docs/SETUP.md`](docs/SETUP.md) — install, configure, and run this, for
  local development and for production.
- [`docs/TESTING.md`](docs/TESTING.md) — run the tests, and troubleshoot a
  deployment.

## License

[GPL-3.0-or-later](LICENSE).

## Disclaimer

This software comes with no warranty. Use it at your own risk. The
authors and contributors accept no liability for damages that result
from using it — data loss, a misconfigured or broken game server, or
any other harm. See sections 15 and 16 of the [license](LICENSE) for
the full legal terms.
