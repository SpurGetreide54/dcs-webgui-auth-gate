const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

let activeSlotPath;

test.before(() => {
  activeSlotPath = path.join(os.tmpdir(), `active-slot-test-${crypto.randomBytes(6).toString("hex")}`);
  process.env.ACTIVE_SLOT_PATH = activeSlotPath;
});

test.after(() => {
  fs.rmSync(activeSlotPath, { force: true });
});

test("writeActiveSlot writes through a tmp-file-plus-rename, leaving no leftover tmp file", () => {
  const activeSlot = require("../src/activeSlot");
  activeSlot.writeActiveSlot("b");
  assert.equal(fs.readFileSync(activeSlotPath, "utf8"), "b");
  assert.equal(activeSlot.readActiveSlot(), "b");

  const leftovers = fs.readdirSync(path.dirname(activeSlotPath)).filter((name) => name.startsWith(`${path.basename(activeSlotPath)}.`));
  assert.deepEqual(leftovers, []);
});

test("writeActiveSlot rejects anything that isn't a real slot name", () => {
  const activeSlot = require("../src/activeSlot");
  assert.throws(() => activeSlot.writeActiveSlot("c"), /Invalid slot/);
});
