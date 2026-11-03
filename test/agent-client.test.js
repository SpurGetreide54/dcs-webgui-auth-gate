const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// a tiny default, set before agentClient.js is first required, so
// the "default timeout" test doesn't have to wait near a minute
process.env.AGENT_RELAY_TIMEOUT_MS = "50";

const agentClient = require("../src/agentClient");

// a minimal http server standing in for the mission agent, replying
// after the given delay so timeout behavior is actually exercised
function startDummyAgent(delayMs, handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        if (handler) handler(req, res);
        else res.end("ok");
      }, delayMs);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("isConfigured reflects an env var change made after the module was first required, no re-require needed", () => {
  const savedUrl = process.env.MISSION_AGENT_URL;
  const savedToken = process.env.MISSION_AGENT_TOKEN;
  try {
    delete process.env.MISSION_AGENT_URL;
    delete process.env.MISSION_AGENT_TOKEN;
    assert.equal(agentClient.isConfigured(), false);

    process.env.MISSION_AGENT_URL = "http://127.0.0.1:1";
    process.env.MISSION_AGENT_TOKEN = "some-token";
    assert.equal(agentClient.isConfigured(), true, "setting the env vars after require must take effect immediately");

    delete process.env.MISSION_AGENT_TOKEN;
    assert.equal(agentClient.isConfigured(), false, "either var missing must be enough to report unconfigured");
  } finally {
    if (savedUrl === undefined) delete process.env.MISSION_AGENT_URL;
    else process.env.MISSION_AGENT_URL = savedUrl;
    if (savedToken === undefined) delete process.env.MISSION_AGENT_TOKEN;
    else process.env.MISSION_AGENT_TOKEN = savedToken;
  }
});

test("agentFetch throws cleanly when the agent isn't configured, without ever calling fetch", async () => {
  const savedUrl = process.env.MISSION_AGENT_URL;
  delete process.env.MISSION_AGENT_URL;
  try {
    await assert.rejects(() => agentClient.agentFetch("/ping"), /not configured/);
  } finally {
    if (savedUrl === undefined) delete process.env.MISSION_AGENT_URL;
    else process.env.MISSION_AGENT_URL = savedUrl;
  }
});

test("agentFetch resolves the path against MISSION_AGENT_URL and sets the bearer token header", async () => {
  let receivedAuth, receivedUrl;
  const dummy = await startDummyAgent(0, (req, res) => {
    receivedAuth = req.headers.authorization;
    receivedUrl = req.url;
    res.end("ok");
  });
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummy.address().port}`;
  process.env.MISSION_AGENT_TOKEN = "agent-client-test-token";
  try {
    const res = await agentClient.agentFetch("/ping");
    assert.equal(res.status, 200);
    assert.equal(receivedAuth, "Bearer agent-client-test-token");
    assert.equal(receivedUrl, "/ping");
  } finally {
    dummy.close();
  }
});

test("agentFetch aborts past the default timeout when the call site doesn't override it", async () => {
  // the module-load-time default is 50ms (set at the top of this
  // file); 150ms of server delay must trip it
  const dummy = await startDummyAgent(150);
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummy.address().port}`;
  process.env.MISSION_AGENT_TOKEN = "agent-client-test-token";
  try {
    await assert.rejects(() => agentClient.agentFetch("/slow"));
  } finally {
    dummy.close();
  }
});

test("a per-call timeoutMs overrides the default, letting a slower-than-default call still succeed", async () => {
  // 150ms of server delay, which the 50ms default above would abort,
  // but a 1000ms override comfortably survives
  const dummy = await startDummyAgent(150);
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummy.address().port}`;
  process.env.MISSION_AGENT_TOKEN = "agent-client-test-token";
  try {
    const res = await agentClient.agentFetch("/slow", { timeoutMs: 1000 });
    assert.equal(res.status, 200);
  } finally {
    dummy.close();
  }
});

test("scaledTimeoutMs grows with body size and never returns less than the default", () => {
  const defaultMs = agentClient.getDefaultTimeoutMs();
  assert.equal(agentClient.scaledTimeoutMs(0), defaultMs);
  const small = agentClient.scaledTimeoutMs(1024 * 1024);
  const large = agentClient.scaledTimeoutMs(100 * 1024 * 1024);
  assert.ok(small > defaultMs, "a non-empty body must push the deadline past the bare default");
  assert.ok(large > small, "a larger body must push the deadline out further than a smaller one");
});

test("getUrl/getToken expose the raw env values, for callers that configure a proxy target rather than fetching", () => {
  process.env.MISSION_AGENT_URL = "http://127.0.0.1:9999";
  process.env.MISSION_AGENT_TOKEN = "raw-token";
  assert.equal(agentClient.getUrl(), "http://127.0.0.1:9999");
  assert.equal(agentClient.getToken(), "raw-token");
});
