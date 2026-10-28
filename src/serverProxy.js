// express, the proxy middleware, and the two lookups this proxy needs
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const controlTokens = require("./controlTokens");
const serversDb = require("./servers");

const CONTROL_PORT = Number(process.env.WEBGUI_CONTROL_PORT || 8088);
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;

// build the control-port proxy app, routing each request to the right
// dcs server by control token, never by anything the client supplies
// see docs/Why.md#why-is-there-only-one-shared-control-port
function buildControlProxyApp() {
  const app = express();
  // drop the x-powered-by header, no need to advertise the framework
  app.disable("x-powered-by");

  // reflect the request's own origin so a cross-origin fetch's cors
  // preflight succeeds, safe here since auth rides on the opaque
  // token alone, see docs/Why.md#why-is-it-safe-to-reflect-the-origin
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "X-Auth-Gate-Token, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    // never pair this with a wildcard origin
    res.set("Access-Control-Allow-Credentials", "true");
    // answer the preflight itself, nothing else to do for it
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // check the control token and attach where it should be relayed to
  app.use((req, res, next) => {
    // resolve the token to its admin and server, if it's still valid
    const token = req.get("X-Auth-Gate-Token");
    const entry = token && controlTokens.resolve(token);
    if (!entry) return res.status(403).send("Forbidden: missing or expired control-port token.");

    // re-check live access, even though the token already named this admin
    if (!serversDb.hasServerAccess(entry.adminId, entry.serverId)) {
      return res.status(403).send("Forbidden: access to this server was revoked.");
    }
    const server = serversDb.getServerById(entry.serverId);
    if (!server) return res.status(404).send("Unknown server.");

    // refuse to proxy anywhere if the agent isn't configured at all
    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
      return res.status(500).send("Mission agent is not configured.");
    }

    // the dcs host's control port only accepts 127.0.0.1 on its own
    // machine, so the agent running there does the last hop, this
    // just relays to it, scoped to this token's own server
    req.dcsAgentUrl = MISSION_AGENT_URL;
    req.dcsAgentPathPrefix = `/webgui/${encodeURIComponent(server.instance_name)}`;
    next();
  });

  // the actual proxy, routed and rewritten per request from above
  const proxyMiddleware = createProxyMiddleware({
    router: (req) => req.dcsAgentUrl,
    pathRewrite: (reqPath, req) => `${req.dcsAgentPathPrefix}${reqPath}`,
    changeOrigin: true,
    ws: true,
    on: {
      proxyReq(proxyReq) {
        // server to server only, this bearer token never reaches the
        // browser, and the browser's own token never reaches the agent
        proxyReq.setHeader("Authorization", `Bearer ${MISSION_AGENT_TOKEN}`);
      },
      // a failed upstream connection becomes a plain text error, not a crash
      error(err, req, res) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Could not reach the DCS server: ${err.message}`);
      },
    },
  });
  app.use(proxyMiddleware);

  return { app, proxyMiddleware };
}

// start the control-port proxy listening, websocket upgrades included
function startControlProxy() {
  const { app, proxyMiddleware } = buildControlProxyApp();
  const httpServer = app.listen(CONTROL_PORT, () => {
    console.log(`dcs-webgui control-port proxy listening on :${CONTROL_PORT}`);
  });
  // route websocket upgrade requests through the same proxy
  httpServer.on("upgrade", proxyMiddleware.upgrade);
  return httpServer;
}

// expose the starter, the builder (for tests), and the port itself
module.exports = { startControlProxy, buildControlProxyApp, CONTROL_PORT };
