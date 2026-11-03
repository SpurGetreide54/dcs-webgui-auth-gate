const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { fetchGithub } = require("../src/githubApi");

// a minimal http server that accepts the connection but never answers,
// standing in for a stalled github connection
function startStallingServer() {
  return new Promise((resolve) => {
    const server = http.createServer(() => {});
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("fetchGithub aborts a stalled connection within the given timeoutMs, instead of hanging forever", async () => {
  const server = await startStallingServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(() => fetchGithub(base, "test-agent", { timeoutMs: 50 }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchGithub succeeds well within its timeout against a server that answers promptly", async () => {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetchGithub(base, "test-agent", { timeoutMs: 1000 });
    assert.equal(res.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
