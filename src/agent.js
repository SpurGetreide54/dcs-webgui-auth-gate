// Runs on the physical host, next to the DCS gameservers. Deliberately
// tiny and dependency-light: a single write-only endpoint, a shared-token
// check, and path-traversal-safe filename handling. No accounts, no login,
// no read/list/delete of the mission folders it's given.
//
// Deploy on Windows as a service (e.g. via NSSM or node-windows), since
// there's no existing Node process supervisor on that host.

const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const PORT = Number(process.env.AGENT_PORT || 4000);
const AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;
const MAX_MISSION_BYTES = Number(process.env.MAX_MISSION_BYTES || 200 * 1024 * 1024);

if (!AGENT_TOKEN) {
  console.error("MISSION_AGENT_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

// folder_key -> absolute path on this host. Set these to the real mission
// folders before deploying; keys must match `mission_folder_key` in the
// auth-gate's `servers` table.
const MISSION_FOLDERS = {
  training: process.env.MISSION_FOLDER_TRAINING,
  community1: process.env.MISSION_FOLDER_COMMUNITY1,
  community2: process.env.MISSION_FOLDER_COMMUNITY2,
};

for (const [key, dir] of Object.entries(MISSION_FOLDERS)) {
  if (!dir) {
    console.error(`Missing mission folder path for "${key}" (set MISSION_FOLDER_${key.toUpperCase()}).`);
    process.exit(1);
  }
}

const app = express();
app.disable("x-powered-by");

function checkToken(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return res.status(401).send("Missing bearer token.");
  const expected = Buffer.from(AGENT_TOKEN);
  const got = Buffer.from(token);
  // Constant-time comparison; timing differences on a naive === here would
  // leak the token one byte at a time to anyone who can reach this port.
  const match = expected.length === got.length && crypto.timingSafeEqual(expected, got);
  if (!match) return res.status(401).send("Invalid bearer token.");
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MISSION_BYTES, files: 1 },
});

app.post("/upload", checkToken, upload.single("mission"), async (req, res) => {
  const folderKey = req.body?.folder_key;
  const targetDir = MISSION_FOLDERS[folderKey];
  if (!targetDir) return res.status(400).send("Unknown or missing folder_key.");
  if (!req.file) return res.status(400).send("No file provided.");

  // path.basename strips any directory components; the extension check
  // and the follow-up resolve()-inside-targetDir check are what actually
  // stop a crafted filename (e.g. "../../autoexec.cfg") from writing
  // outside the mission folder.
  const safeName = path.basename(req.file.originalname);
  if (!safeName.toLowerCase().endsWith(".miz")) {
    return res.status(400).send("Only .miz files are accepted.");
  }

  const finalPath = path.join(targetDir, safeName);
  const resolvedTarget = path.resolve(targetDir);
  const resolvedFinal = path.resolve(finalPath);
  if (resolvedFinal !== resolvedTarget && !resolvedFinal.startsWith(resolvedTarget + path.sep)) {
    return res.status(400).send("Invalid filename.");
  }

  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmpPath, req.file.buffer);
    await fs.rename(tmpPath, finalPath); // atomic on the same filesystem: DCS never sees a partial file
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    return res.status(500).send(`Write failed: ${err.message}`);
  }

  res.json({ ok: true, path: finalPath });
});

app.use((req, res) => res.status(404).send("Not found."));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`mission-agent listening on :${PORT}`);
  });
}

module.exports = app;
