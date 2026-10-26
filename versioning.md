# Versioning

Standard SemVer (`MAJOR.MINOR.PATCH`), per `manifest/versioning.md`'s methodology (see that file for the full rationale — this is this project's own adoption of it, not a separate scheme).

## Bump meaning

- **PATCH** — bugfix, no behavior/config/API change.
- **MINOR** — new backward-compatible feature (e.g. a new admin page, a new optional env var).
- **MAJOR** — breaking change: an incompatible `.env`/config change, a breaking change to the signed update manifest format, or anything that makes an in-place upgrade from the previous version unsafe without a manual migration step.

## Starting point

Doesn't start at `0.1.0`. This project already had real history and a running production deployment before `manifest/versioning.md` existed — its first ever tag was `1.0.0-dev`, not `0.1.0`, and that continues forward rather than resetting. Current version at the time this rule was adopted: `1.2.3-alpha`.

## Maturity tag: `-alpha` is the default, not a one-time label

Every bump — PATCH, MINOR, or MAJOR alike — keeps the `-alpha` pre-release suffix by default (`1.2.4-alpha`, `1.3.0-alpha`, `2.0.0-alpha`, …), standard SemVer pre-release precedence (`-alpha` sorts below the same version with no suffix). This continues until a deliberate decision to promote a release to `-beta` or to drop the suffix entirely for a real stable release — not something that happens automatically just because the numbers get bigger.

## Schema version

No separate schema-version counter. `src/db.js`'s migrations are guarded idempotent checks baked directly into schema setup (e.g. checking a column exists before adding it), not a numbered migration sequence — so there's nothing to track outside the SemVer above.
