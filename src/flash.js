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
  try {
    // parse the stored json back into an object
    return JSON.parse(raw);
  } catch {
    // a corrupt or tampered cookie is treated as no flash at all
    return {};
  }
}

// expose both functions to callers
module.exports = { setFlash, readFlash };
