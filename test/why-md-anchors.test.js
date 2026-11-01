const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WHY_MD_PATH = path.join(ROOT, "docs", "Why.md");

// github's own heading-to-anchor algorithm: lowercase, drop every
// character except letters/digits/hyphen/underscore/space, spaces to
// hyphens -- no replacement character for anything else
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, "")
    .trim()
    .replace(/ /g, "-");
}

// every `## heading` in docs/Why.md, turned into its real anchor
function realAnchors() {
  const text = fs.readFileSync(WHY_MD_PATH, "utf8");
  const anchors = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(/^## (.+)$/);
    if (match) anchors.add(slugify(match[1]));
  }
  return anchors;
}

// every file under a directory, recursively, matching the given extensions
function walk(dir, extensions) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      results.push(...walk(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

// every `docs/Why.md#<anchor>` reference found in the given files, each
// tagged with the file:line it came from
function findReferences(files) {
  const references = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(/docs\/Why\.md#([a-z0-9_-]+)/g)) {
        references.push({ file: path.relative(ROOT, file), line: i + 1, anchor: match[1] });
      }
    });
  }
  return references;
}

test("every docs/Why.md#<anchor> pointer in src/, scripts/ and launcher.js resolves to a real heading", () => {
  const anchors = realAnchors();
  const files = [...walk(path.join(ROOT, "src"), [".js"]), ...walk(path.join(ROOT, "scripts"), [".js", ".sh", ".ps1"]), path.join(ROOT, "launcher.js")].filter(fs.existsSync);
  const references = findReferences(files);
  assert.ok(references.length > 0, "expected to find at least one docs/Why.md pointer to check");

  const stale = references.filter((ref) => !anchors.has(ref.anchor));
  assert.deepEqual(stale, [], `stale docs/Why.md anchors found:\n${stale.map((s) => `  ${s.file}:${s.line} -> #${s.anchor}`).join("\n")}`);
});
