# Roles and permissions

## Site admin

An account with `can_manage_accounts`. A site admin:

- creates, edits, and deletes other admin accounts
- grants or revokes server access and mission permissions
- reaches `/admin/update` and `/admin/settings`

The app always keeps at least one site admin. Deleting the last one
is blocked.

## Per-server access

A site admin grants each admin access to specific servers,
individually.<br>Access to one server says nothing about any other.

## Mission permissions

Four separate grants, per admin, per server:

| Permission | Gates |
|---|---|
| `view` | Reaching that server's missions page at all. |
| `upload` | Uploading a `.miz` file. |
| `download` | Downloading one or more missions. |
| `delete` | Moving a mission to trash. See [FAQ](FAQ.md) for why this never actually deletes a file. |

An admin with `upload` but not `view` still cannot reach the missions
page.<br>Grant `view` alongside any of the other three.

## Where this is managed

All of the above is managed from a popup on each admin's row in
`/admin/accounts`, not inline checkboxes.<br>There are too many
permissions for that to stay readable on one row.
