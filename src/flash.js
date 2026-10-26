// Carries a one-shot {error/notice/...} payload across a redirect, so a
// POST handler can redirect-after-write (stopping a reload from
// resubmitting the form) while the following GET still shows the result.
// A plain cookie, not a session: the existing sessions table requires a
// logged-in admin_id, which doesn't exist yet on pre-auth routes like
// /login and /setup. Unsigned, because everything ever carried here
// (a validation error, an invite URL) is something the same browser's
// own user is about to see again anyway -- nothing sensitive to that
// user tampering with their own cookie before their own next page load.
const FLASH_COOKIE = "dcs_flash";

function setFlash(res, data) {
  res.cookie(FLASH_COOKIE, JSON.stringify(data), { httpOnly: true, maxAge: 10000, sameSite: "lax" });
}

function readFlash(req, res) {
  const raw = req.cookies[FLASH_COOKIE];
  if (!raw) return {};
  res.clearCookie(FLASH_COOKIE);
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

module.exports = { setFlash, readFlash };
