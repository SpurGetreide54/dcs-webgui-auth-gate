# Testing

## Running the suite

```
npm test
```

This runs `node --test` against `test/`.

## What it covers

Login, access checks, uploads, proxying, and the admin pages.<br>Dummy
in-process HTTP servers stand in for the mission-agent.

## What it does not cover

- a real DCS server
- a real Windows host running `agent.exe`
- a real reverse-proxy hop

A real deployment is the only way to check those.<br>See
[Installation](Installation.md).
