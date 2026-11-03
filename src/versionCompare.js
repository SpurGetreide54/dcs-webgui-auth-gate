// side-effect-free SemVer-ish version comparison, shared by
// updateCheck.js (the gate) and agent.js (the agent), which cannot
// require updateCheck.js directly since that module pulls in db.js

// parse "X.Y.Z[-prerelease]" into its numeric triple and prerelease string
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (!match) throw new Error(`Cannot parse version "${version}".`);
  return { triple: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || null };
}

// SemVer precedence for the prerelease field: no prerelease outranks
// having one on the same X.Y.Z triple; otherwise compare dot-separated
// identifiers left to right, numeric values numerically, else as strings
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    if (aParts[i] === undefined) return -1;
    if (bParts[i] === undefined) return 1;
    const aNum = /^\d+$/.test(aParts[i]) ? Number(aParts[i]) : null;
    const bNum = /^\d+$/.test(bParts[i]) ? Number(bParts[i]) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else if (aParts[i] !== bParts[i]) {
      return aParts[i] > bParts[i] ? 1 : -1;
    }
  }
  return 0;
}

// true only if a's version strictly outranks b's: by X.Y.Z first,
// then SemVer prerelease precedence if the triple is equal
// see docs/Why.md#why-does-checkforupdate-reject-a-lower-or-equal-version
function isVersionGreater(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va.triple[i] !== vb.triple[i]) return va.triple[i] > vb.triple[i];
  }
  return comparePrerelease(va.prerelease, vb.prerelease) > 0;
}

module.exports = { isVersionGreater };
