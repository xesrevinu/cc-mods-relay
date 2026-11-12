import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  orphanPluginPids,
  parsePs,
  reapOrphanHerdrWorkspaces,
  stampWorkspace,
} from "../src/tui-reap.js";

test("orphanPluginPids keeps a TUI with a live parent and reaps PPID 1", () => {
  const plugin = "/tmp/cc-mods-plugin";
  const rows = parsePs(`
    10 1 herdr --session claude server
    20 10 -sh
    21 20 claude --plugin-dir ${plugin} --session-id live
    22 21 bun ${plugin}/hooks/ws-client.js
    30 1 claude --plugin-dir ${plugin} --session-id dead
    31 1 bun ${plugin}/hooks/ws-client.js
    40 1 vim README.md
  `);
  const alive = (pid: number) => pid === 10 || pid === 20 || pid === 21;
  expect(orphanPluginPids(rows, plugin, alive).sort()).toEqual([30, 31]);
});

test("reapOrphanHerdrWorkspaces closes dead-agent stamps and unstamped claude-tui panes", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-mods-stamp-"));
  const session = "cc-mods-test";
  stampWorkspace(session, { workspaceId: "wLive", paneId: "pLive" }, process.pid, root);
  stampWorkspace(session, { workspaceId: "wDead", paneId: "pDead" }, 99_999_123, root);

  const calls: string[] = [];
  const runCli = (argv: string[]) => {
    const i = argv.indexOf("--session");
    const cmd = argv.slice(i >= 0 ? i + 2 : 1);
    calls.push(cmd.join(" "));
    if (cmd[0] === "workspace" && cmd[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            workspaces: [
              { workspace_id: "wLive", label: "claude-tui" },
              { workspace_id: "wDead", label: "claude-tui" },
              { workspace_id: "wGhost", label: "claude-tui" },
              { workspace_id: "wOther", label: "shell" },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (cmd[0] === "pane" && cmd[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            panes: [
              { pane_id: "pLive", workspace_id: "wLive" },
              { pane_id: "pDead", workspace_id: "wDead" },
              { pane_id: "pGhost", workspace_id: "wGhost" },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (cmd[0] === "pane" && cmd[1] === "process-info") {
      const pane = cmd[cmd.indexOf("--pane") + 1];
      const pid = pane === "pDead" ? 4242 : pane === "pGhost" ? 4243 : 7;
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { process_info: { foreground_processes: [{ name: "claude", pid, cmdline: "claude" }] } },
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: "{}", stderr: "" };
  };

  const result = reapOrphanHerdrWorkspaces({
    herdrSession: session,
    runCli,
    stampRoot: root,
    alive: (pid) => pid === process.pid,
  });
  expect(result.closed.sort()).toEqual(["wDead", "wGhost"]);
  expect(result.pids.sort()).toEqual([4242, 4243]);
  expect(calls.some((c) => c === "workspace close wLive")).toBe(false);
  expect(calls.some((c) => c === "workspace close wOther")).toBe(false);
});
