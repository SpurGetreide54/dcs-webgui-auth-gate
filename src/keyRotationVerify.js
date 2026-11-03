// side-effect-free rotation-record verification, shared by
// keyRotation.js (the gate) and agent.js (the agent), which cannot
// require keyRotation.js directly since that module pulls in db.js

const crypto = require("node:crypto");
const { keyStateMessage } = require("./keyRotationConstants");

// true only if every one of a rotation record's checks pass: the new
// key's own self-signature, the surviving slot's vouching signature,
// and a strictly-newer rotated_at than what's already trusted
function verifyKeyState(record, currentState) {
  try {
    // branch: an unrecognized slot name
    if (record.rotated_slot !== "primary" && record.rotated_slot !== "secondary") return false;
    if (!Array.isArray(record.signatures) || record.signatures.length !== 2) return false;

    const message = keyStateMessage(record);

    // the new key proving it holds the private half it claims to
    const newPublicKey = crypto.createPublicKey(record.new_public_key_pem);
    const selfSignatureOk = crypto.verify(null, message, newPublicKey, Buffer.from(record.signatures[0], "hex"));

    // the slot NOT being rotated is the one that actually authorizes this
    const survivingSlot = record.rotated_slot === "primary" ? "secondary" : "primary";
    const survivingPublicKey = crypto.createPublicKey(currentState[`${survivingSlot}_public_key_pem`]);
    const vouchSignatureOk = crypto.verify(null, message, survivingPublicKey, Buffer.from(record.signatures[1], "hex"));

    // rejects an attacker replaying an old, previously-valid record
    const currentRotatedAt = currentState[`${record.rotated_slot}_rotated_at`];
    const isNewer = new Date(record.rotated_at).getTime() > new Date(currentRotatedAt).getTime();

    return selfSignatureOk && vouchSignatureOk && isNewer;
  } catch {
    // any malformed field (bad pem, bad hex, bad date) is a rejection
    return false;
  }
}

module.exports = { verifyKeyState };
