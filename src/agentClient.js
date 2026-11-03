// one place reading the shared mission-agent env vars and wrapping
// every call to it, so the auth header, the "not configured" guard,
// and a default timeout aren't each repeated at every call site
// see docs/Why.md#why-does-agentclient-read-its-env-vars-lazily

const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_RELAY_TIMEOUT_MS) || 60 * 1000;

// true once both env vars the agent needs are set
function isConfigured() {
  return Boolean(process.env.MISSION_AGENT_URL && process.env.MISSION_AGENT_TOKEN);
}

// fetch one path on the mission agent, with its bearer token and a
// default timeout already applied; init can still override either
async function agentFetch(path, init = {}) {
  if (!isConfigured()) throw new Error("Mission agent is not configured.");
  const url = new URL(path, process.env.MISSION_AGENT_URL);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${process.env.MISSION_AGENT_TOKEN}`);
  return fetch(url, { ...init, headers, signal: init.signal || AbortSignal.timeout(init.timeoutMs || DEFAULT_TIMEOUT_MS) });
}

module.exports = {
  isConfigured,
  agentFetch,
  getUrl: () => process.env.MISSION_AGENT_URL,
  getToken: () => process.env.MISSION_AGENT_TOKEN,
  getDefaultTimeoutMs: () => DEFAULT_TIMEOUT_MS,
};
