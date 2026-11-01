// ed25519 public keys seeding the primary/secondary key-rotation
// trust root, side-effect free so db.js can seed key_state from it
// without a require cycle, same reasoning as updateConstants.js
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

module.exports = { PRIMARY_PUBLIC_KEY_PEM, SECONDARY_PUBLIC_KEY_PEM };
