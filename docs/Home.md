# DCS Webgui Auth Gate

DCS World is a combat flight simulator. People run private multiplayer
game servers for it. Each DCS dedicated-server install ships its own
admin control panel from Eagle Dynamics. It manages missions, players,
and more for that one server.

The control panel talks to the game server through a control port.
The control port only accepts connections from 127.0.0.1, the
server's own machine. Out of the box, only someone logged into that
exact machine can reach it.

This project puts a gate in front of that control panel. It lets
several admins reach the panel securely from anywhere. It never
exposes the control port to the open internet. Each admin gets their
own login and their own scoped access. One deployment can front
several DCS servers at once.

This repo does not include the real control panel's own files
(`index.html`, `app.js`, and so on). That code belongs to Eagle
Dynamics. A deployer supplies their own legitimate copy.

## Pages

- [Architecture](Architecture.md): how the two processes fit
  together, and why.
- [Deployment Topology](Deployment-Topology.md): the intended setup.
- [Installation](Installation.md): deploy this to production.
- [Configuration](Configuration.md): every environment variable.
- [Roles and Permissions](Roles-and-Permissions.md): what an admin
  can and cannot do.
- [A/B Self-Update](A-B-Self-Update.md): how updates apply themselves.
- [Testing](Testing.md): run the test suite.
- [Troubleshooting](Troubleshooting.md): fix a specific symptom.
- [FAQ](FAQ.md): why the app works the way it does.
- [Glossary](Glossary.md): every term, defined once.

## License

[GPL-3.0-or-later](https://github.com/SpurGetreide54/dcs-webgui-auth-gate/blob/main/LICENSE).

## Disclaimer

This software comes with no warranty. Use it at your own risk. The
authors and contributors accept no liability for damages that result
from using it. See sections 15 and 16 of the license for the full
legal terms.
