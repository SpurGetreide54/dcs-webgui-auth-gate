// the one github api fetch path shared by updateCheck.js and
// keyRotation.js, so a change such as a timeout or an auth header is
// made once, not twice

// overridable so tests can point this at a local dummy server instead
// of the real github api
const GITHUB_API_BASE = process.env.GITHUB_API_BASE_OVERRIDE || "https://api.github.com";

// a total deadline, not an idle one, same convention as agentClient.js;
// github's own json api calls are small, so this is already generous
const DEFAULT_TIMEOUT_MS = 15 * 1000;

// fetches a url with the given User-Agent, returning the raw response
// so a caller can inspect its status (a 404) before parsing the body
async function fetchGithub(url, userAgent, { timeoutMs } = {}) {
  return fetch(url, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
  });
}

module.exports = { GITHUB_API_BASE, fetchGithub };
