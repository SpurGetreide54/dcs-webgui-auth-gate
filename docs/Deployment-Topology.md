# Deployment topology

## The intended setup

One physical Windows machine runs the DCS gameserver (or several),
directly.<br>A virtual machine, hosted on that same physical machine,
runs the auth-gate.

- The physical host runs the DCS gameservers and the mission-agent.
- The VM runs the auth-gate.
- The VM and the host talk over a hypervisor-provided internal or
  private virtual switch, not the real LAN.

This is the setup this project is built and tested against.<br>It keeps
the auth-gate in its own isolated environment, with its own update
lifecycle, without needing a second piece of physical hardware.

## The VM is not internet-facing

A reverse proxy sits in front of the auth-gate VM.<br>It is the only
piece reachable from outside.<br>The reverse proxy lives in a separate
repo, `dcs-webgui-reverse-proxy`.<br>See that repo for its own setup.

```
admins on the internet
        |
   reverse proxy  (internet-facing)
        |
   auth-gate VM   (hypervisor-internal network only)
        |
   physical host  (DCS gameservers + mission-agent)
```

## Why no HOST/BIND_ADDRESS setting?

`app.listen(PORT)` binds every interface, with no bind-address
control.<br>On a single-NIC-per-VM deployment — the only one this
project is built and tested against, and the only shape described
above — there is nothing to bind to differently from `0.0.0.0`: the
VM has exactly one address into its network either way.<br>The real
boundary is the firewall: only the reverse proxy's address may reach
this port.<br>A `HOST`/`BIND_ADDRESS` env var would be dead weight
here, and on any similarly-shaped deployment.

## Two genuinely separate physical machines

Nothing in the code assumes the auth-gate and the DCS host share one
physical box.<br>Two separate machines, talking over a real network,
may work.<br>This configuration has not been tested, and is out of
scope of this project.
