// Process entry point. The app itself lives in app.ts so that tests can
// mount it on an ephemeral port instead of racing for the production one.
import { app } from "./app.js";
import { log } from "./log.js";

// Sessions are signed by jose, which uses WebCrypto — a global only from Node
// 19 on. On an older runtime nothing fails at boot; instead every sign-in
// throws "crypto is not defined" deep inside the handler and the caller hangs.
// Far better to refuse to start and say why.
if (typeof globalThis.crypto?.subtle === "undefined") {
  log.error("process.unsupported_runtime", {
    nodeVersion: process.version,
    required: ">=20",
    reason: "globalThis.crypto.subtle is missing, so session signing cannot work",
  });
  process.exit(1);
}

const port = Number(process.env.PORT) || 4000;

app.listen(port, "0.0.0.0", () => {
  log.info("server.listening", { port, engineVersion: "DTE-1.0" });
});

// Without this, a rejected promise outside a route handler takes the process
// down with no record of what caused it. Logged, not fatal — an unhandled
// rejection usually means one request failed, not that the process is unsound.
process.on("unhandledRejection", (reason) => {
  log.error("process.unhandled_rejection", { error: reason });
});

// An uncaught exception leaves the process in an unknown state, so it does
// have to die — but on a non-zero code. Exiting 0 here would tell Railway the
// deploy came up fine and suppress the restart policy, which is exactly what
// a failed port bind must not do.
process.on("uncaughtException", (error) => {
  log.error("process.uncaught_exception", { error });
  process.exit(1);
});
