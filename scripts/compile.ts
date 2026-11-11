/**
 * `bun run compile`: runs the build:<os>-<arch> script for this machine, then puts the binary at
 * dist/cc-mods-relay, where package.json's bin points, so `bun link` installs it.
 */
import { copyFileSync, linkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const WINDOWS = process.platform === "win32";
const EMBEDDED_AGENT_PLACEHOLDER = 'throw new Error("cc-mods-relay: embedded agent missing");\n';

const os = WINDOWS ? "windows" : process.platform;
const target = `${os}-${process.arch}`;
const script = `build:${target}`;
if (!(script in pkg.scripts)) {
  const known = Object.keys(pkg.scripts)
    .filter((s) => s.startsWith("build:"))
    .map((s) => s.slice("build:".length));
  console.error(`compile: no build script for ${target}. Known targets: ${known.join(", ")}`);
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const embeddedAgent = join(root, "src/embedded-agent.js");

const embed = Bun.spawnSync(
  ["bun", "build", join(root, "src/agent.ts"), "--target=bun", "--minify", "--outfile", embeddedAgent],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
if (embed.exitCode !== 0) process.exit(embed.exitCode ?? 1);

try {
  const build = Bun.spawnSync(["bun", "run", script], {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
} finally {
  writeFileSync(embeddedAgent, EMBEDDED_AGENT_PLACEHOLDER);
}

// Bun adds .exe to Windows builds. The bin keeps no extension so one package.json fits every
// platform; the .exe copy is for running or copying by hand, and is a hard link rather than a
// second copy of the binary.
const exe = WINDOWS ? ".exe" : "";
const dist = join(root, "dist");
const built = join(dist, `cc-mods-relay-${target}${exe}`);
const bin = join(dist, "cc-mods-relay");
const linked = join(dist, `cc-mods-relay${exe}`);
copyFileSync(built, bin);
if (exe) {
  rmSync(linked, { force: true });
  linkSync(bin, linked);
}
console.log(`compile: ${built} -> ${bin}${exe ? `, ${linked}` : ""}`);
