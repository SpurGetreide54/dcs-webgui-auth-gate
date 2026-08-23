const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const controlTokens = require("./controlTokens");
const serversDb = require("./servers");

const CONTROL_PORT = Number(process.env.WEBGUI_CONTROL_PORT || 8088);
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;

// One shared port for every configured DCS server, matching the real DCS
// webgui's own default, so admins never learn a different port per
// server. Which real upstream a connection reaches is resolved from the
// control-gate token (see controlTokens.js), never from anything the
// client supplies directly. That's what stops "just try a different port"
// from reaching a server you don't have a grant for.
function buildControlProxyApp() {
  const app = express();
  app.disable("x-powered-by");

  // The token is a custom header, so cross-origin fetch() sends a CORS
  // preflight OPTIONS first. Reflecting the request's own Origin is safe
  // here. Authorization rides entirely on the opaque token, not on any
  // browser-ambient credential a third-party origin could piggyback on.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "X-Auth-Gate-Token, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    // Reflecting a specific origin, never "*", is what makes this safe to
    // pair with Access-Control-Allow-Credentials.
    res.set("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    const token = req.get("X-Auth-Gate-Token");
    const entry = token && controlTokens.resolve(token);
    if (!entry) return res.status(403).send("Forbidden: missing or expired control-port token.");

    if (!serversDb.hasServerAccess(entry.adminId, entry.serverId)) {
      return res.status(403).send("Forbidden: access to this server was revoked.");
    }
    const server = serversDb.getServerById(entry.serverId);
    if (!server) return res.status(404).send("Unknown server.");

    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
      return res.status(500).send("Mission agent is not configured.");
    }

    // The DCS host's control port only accepts 127.0.0.1 on its own
    // machine. Nothing running here can dial it directly. The agent runs
    // on that machine and does the last hop. This just relays to it,
    // scoped by instance_name to the specific server this token was
    // minted for.
    req.dcsAgentUrl = MISSION_AGENT_URL;
    req.dcsAgentPathPrefix = `/webgui/${encodeURIComponent(server.instance_name)}`;
    next();
  });

  const proxyMiddleware = createProxyMiddleware({
    router: (req) => req.dcsAgentUrl,
    pathRewrite: (reqPath, req) => `${req.dcsAgentPathPrefix}${reqPath}`,
    changeOrigin: true,
    ws: true,
    on: {
      proxyReq(proxyReq) {
        // Server-to-server only. The browser's own X-Auth-Gate-Token never
        // reaches the agent, and this bearer token never reaches the browser.
        proxyReq.setHeader("Authorization", `Bearer ${MISSION_AGENT_TOKEN}`);
      },
      error(err, req, res) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Could not reach the DCS server: ${err.message}`);
      },
    },
  });
  app.use(proxyMiddleware);

  return { app, proxyMiddleware };
}

function startControlProxy() {
  const { app, proxyMiddleware } = buildControlProxyApp();
  const httpServer = app.listen(CONTROL_PORT, () => {
    console.log(`dcs-webgui control-port proxy listening on :${CONTROL_PORT}`);
  });
  httpServer.on("upgrade", proxyMiddleware.upgrade);
  return httpServer;
}

module.exports = { startControlProxy, buildControlProxyApp, CONTROL_PORT };
