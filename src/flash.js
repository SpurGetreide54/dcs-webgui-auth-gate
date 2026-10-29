// one-shot payload carried across a redirect, so a post handler can
// redirect after writing and the following get still shows the result
// see docs/Why.md#why-is-the-flash-cookie-a-plain-unsigned-cookie
const FLASH_COOKIE = "dcs_flash";

// store a flash payload as a cookie, cleared automatically after 10s
function setFlash(res, data) {
  // write the payload as json, http only so client js can't read it
  res.cookie(FLASH_COOKIE, JSON.stringify(data), { httpOnly: true, maxAge: 10000, sameSite: "lax" });
}

// read and clear this request's flash payload, or {} if there was none
function readFlash(req, res) {
  // grab the raw cookie value, if any
  const raw = req.cookies[FLASH_COOKIE];
  // nothing to read
  if (!raw) return {};
  // one-shot: clear it immediately so it never shows twice
  res.clearCookie(FLASH_COOKIE);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  // a tampered cookie can parse to any json value, not just an object
  // (null, a number, an array), so check the shape before trusting it
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  // copy through only the known string fields, never anything else the
  // cookie might carry
  const flash = {};
  for (const key of ["error", "notice", "inviteUrl"]) {
    if (typeof parsed[key] === "string") flash[key] = parsed[key];
  }
  return flash;
}

// expose both functions to callers
module.exports = { setFlash, readFlash };
