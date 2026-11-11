#!/usr/bin/env bun
const raw = await Bun.stdin.text();
const msg = JSON.parse(raw);
if (typeof msg.path !== "string" || !msg.path.startsWith("/") || typeof msg.base64 !== "string") {
  console.log(JSON.stringify({ ok: false, error: "path and base64 required" }));
  process.exit(1);
}
await Bun.write(msg.path, Buffer.from(msg.base64, "base64"));
console.log(JSON.stringify({ ok: true }));
