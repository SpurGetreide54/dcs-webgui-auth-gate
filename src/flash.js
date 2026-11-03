// one-shot payload carried across a redirect, so a post handler can
// redirect after writing and the following get still shows the result
// see docs/Why.md#why-is-the-flash-cookie-a-plain-unsigned-cookie
const FLASH_COOKIE = "dcs_flash";
// default true, disable only for local http dev; server.js reuses
// this same export for its own session cookie
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
// keeps the encoded cookie well under the browser's ~4KB cap even
// with multibyte text, see docs/Why.md#why-does-the-flash-cookie-cap-error-and-notice-length
const MAX_FLASH_MESSAGE_LENGTH = 500;

// cuts a string to the cap, logging the full text first when it's
// actually cut so the admin can still see it on the logs page
function truncateFlashMessage(text) {
  if (text.length <= MAX_FLASH_MESSAGE_LENGTH) return text;
  console.error(`Flash message truncated for the cookie, full text: ${text}`);
  return `${text.slice(0, MAX_FLASH_MESSAGE_LENGTH)}...`;
}

// store a flash payload as a cookie, cleared automatically after 10s
function setFlash(res, data) {
  // cap error/notice so a long one can never make the cookie too big
  // for the browser to keep, which would silently drop it
  const bounded = { ...data };
  for (const key of ["error", "notice"]) {
    if (typeof bounded[key] === "string") bounded[key] = truncateFlashMessage(bounded[key]);
  }
  // write the payload as json, http only so client js can't read it
  res.cookie(FLASH_COOKIE, JSON.stringify(bounded), { httpOnly: true, secure: COOKIE_SECURE, maxAge: 10000, sameSite: "lax" });
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
    if (typeof parsed[key] !== "string") continue;
    // inviteUrl becomes a real <a href>, unlike error/notice which are
    // only ever displayed as text, so only an actual http(s) url is
    // let through, see docs/Why.md#why-is-the-flash-cookie-a-plain-unsigned-cookie
    if (key === "inviteUrl" && !/^https?:\/\//.test(parsed[key])) continue;
    flash[key] = parsed[key];
  }
  return flash;
}

// expose both functions, plus the cookie-security flag server.js reuses
module.exports = { setFlash, readFlash, COOKIE_SECURE };
