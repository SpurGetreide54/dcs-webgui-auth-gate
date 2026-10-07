// The one piece of the A/B self-update system that never gets replaced by
// it -- see the "Shared shape" section of the update-system design for
// why that's a deliberate, permanent boundary, not a gap to close later.
// Deliberately tiny: read which slot is active, run that slot's real
// server.js. No business logic, no npm dependencies, nothing here an
// update should ever need to touch. Changing this file is a manual,
// deliberate step (edit it over SSH, restart the service by hand) -- it
// intentionally does not share code with src/activeSlot.js, which the
// rest of the app uses for the same read, to keep this file's own
// dependency surface at exactly zero beyond Node itself.
//
// Sits at the top level, a sibling of releases/a/ and releases/b/, not
// under src/ -- systemd's ExecStart targets this file directly and never
// needs to change across updates (see docs/SETUP.md's A/B section).

const fs = require("node:fs");
const path = require("node:path");

const ACTIVE_SLOT_PATH = path.join(__dirname, "active-slot");

let slot;
try {
  const value = fs.readFileSync(ACTIVE_SLOT_PATH, "utf8").trim();
  slot = value === "b" ? "b" : "a";
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  slot = "a";
}

require(path.join(__dirname, "releases", slot, "src", "server.js"));
