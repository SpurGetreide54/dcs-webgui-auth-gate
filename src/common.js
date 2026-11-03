// small stateless infra helpers shared between server.js (the webgui
// auth gate) and agent.js (the mission agent), kept here instead of
// duplicated in both; never requires db.js, since agent.js's esbuild
// SEA bundle has no sqlite dependency of its own
const util = require("node:util");

// admin-typed dcs instance folder name under saved games, dots are
// normal in real instance names, only a string of dots alone is
// rejected
const INSTANCE_NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

// express 4 can't catch a rejected promise on its own, so every async
// handler is wrapped in this to forward the rejection to next()
// see docs/Why.md#why-does-every-async-handler-need-asynchandler
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// catches whatever asyncHandler forwarded, or any other next(err) call;
// must be registered last, after every route and the app's own 404
// see docs/Why.md#why-does-every-async-handler-need-asynchandler
function errorHandler(err, req, res, next) {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${err.message}`);
  if (res.headersSent) return res.end();
  res.status(500).send("Internal server error.");
}

// logs a crash that reached neither asyncHandler nor errorHandler
// above, then exits; no graceful close attempted
// see docs/Why.md#why-does-the-crash-handler-exit-immediately-with-no-graceful-close
function logFatalAndExit(kind, reasonOrError) {
  const err = reasonOrError instanceof Error ? reasonOrError : null;
  console.error(`Fatal ${kind}: ${err ? err.message : util.inspect(reasonOrError)}`);
  console.debug(
    `Fatal ${kind} detail: ${util.inspect({
      stack: err ? err.stack : util.inspect(reasonOrError),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      version: process.version,
    })}`
  );
  process.exit(1);
}

module.exports = { INSTANCE_NAME_RE, asyncHandler, errorHandler, logFatalAndExit };
