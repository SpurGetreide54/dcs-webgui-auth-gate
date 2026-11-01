// ed25519 public keys seeding the key-rotation trust root, side-effect
// free so db.js can seed key_state without a require cycle
// see docs/Why.md#why-do-key-rotation-constants-live-in-their-own-file

// public half of the primary key, the private half never leaves
// local-only/keys/ on the maintainer's own machine
const PRIMARY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADl9rRncZVs+fqce7qBGffawBb+eZpnzJepONnQ4ugMs=
-----END PUBLIC KEY-----
`;

// public half of the secondary key, same reasoning as primary above
const SECONDARY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWRCq+xpQ+cgcwx2ZGdvssx5Sg7910b9gff4jmL8lGTk=
-----END PUBLIC KEY-----
`;

// fixed seed for key_state's rotated_at columns, older than any real
// rotation will ever be, the date the two keys above were created
const INITIAL_KEY_ROTATED_AT = "2026-11-01T00:00:00.000Z";

module.exports = { PRIMARY_PUBLIC_KEY_PEM, SECONDARY_PUBLIC_KEY_PEM, INITIAL_KEY_ROTATED_AT };
