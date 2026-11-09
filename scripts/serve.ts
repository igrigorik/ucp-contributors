#!/usr/bin/env bun
// Local preview. Static file server over site/ — nothing to build.
import { p } from "./lib/data.ts";

const root = p("site");
const wanted = Number(process.env.PORT ?? 8080);

const handler = {
  async fetch(req: Request) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(root + (path === "/" ? "/index.html" : path));
    return (await file.exists())
      ? new Response(file, { headers: { "cache-control": "no-store" } })
      : new Response("not found", { status: 404 });
  },
};

// Walk upward on EADDRINUSE instead of dying with a stack trace. 8080 is the
// most-squatted port in existence — and a squatter need not even be LISTENing:
// a socket merely bound (state CLOSED) blocks the port while staying invisible
// to `lsof -sTCP:LISTEN`. Scanning is deterministic across restarts, unlike
// port 0, so a browser tab survives a server bounce.
let server;
for (let port = wanted; port < wanted + 10; port++) {
  try {
    server = Bun.serve({ port, ...handler });
    break;
  } catch (err) {
    if ((err as { code?: string }).code !== "EADDRINUSE") throw err;
  }
}
if (!server) throw new Error(`no free port in ${wanted}–${wanted + 9}; set PORT=`);

if (server.port !== wanted) console.log(`port ${wanted} is taken — moved up`);
console.log(`http://localhost:${server.port}`);
