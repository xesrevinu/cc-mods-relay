import { expect, test } from "bun:test";
import {
  applyTuiLocale,
  denyWorkspaceEnvKey,
  parseTuiEnv,
  pinTuiLocale,
  stripClientEnv,
  workspaceSpawnEnv,
} from "../src/tools/workspace-env.js";

test("parseTuiEnv keeps Mini locale and display keys and drops injection", () => {
  expect(parseTuiEnv({
    TZ: "Asia/Tokyo",
    LANG: "en_US.UTF-8",
    PATH: "/tmp/evil",
    TZ_evil: "nope",
    LC_TIME: "C",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  })).toEqual({
    TZ: "Asia/Tokyo",
    LANG: "en_US.UTF-8",
    LC_TIME: "C",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  });
  expect(parseTuiEnv({ TZ: "../../etc/passwd" })).toEqual({});
  expect(parseTuiEnv({ LANG: "en_US.UTF-8; rm -rf /" })).toEqual({});
  expect(parseTuiEnv({ TERM: "xterm-256color; rm" })).toEqual({});
  expect(parseTuiEnv("TZ=UTC")).toEqual({});
});

test("stripClientEnv drops secrets and editor identity, keeps PATH/HOME", () => {
  const env = stripClientEnv({
    PATH: "/bin",
    HOME: "/Users/me",
    USER: "me",
    LANG: "zh_CN.UTF-8",
    TZ: "Asia/Shanghai",
    AWS_SECRET_ACCESS_KEY: "x",
    GITHUB_TOKEN: "gho",
    SSH_AUTH_SOCK: "/tmp/ssh",
    CURSOR_TRACE_ID: "abc",
    TERM_PROGRAM: "vscode",
    __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
    CC_MODS_DEBUG: "1",
    EDITOR: "vim",
  });
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/Users/me");
  expect(env.USER).toBe("me");
  expect(env.EDITOR).toBe("vim");
  expect(env.LANG).toBe("zh_CN.UTF-8");
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.SSH_AUTH_SOCK).toBeUndefined();
  expect(env.CURSOR_TRACE_ID).toBeUndefined();
  expect(env.TERM_PROGRAM).toBeUndefined();
  expect(env.__CF_USER_TEXT_ENCODING).toBeUndefined();
  expect(env.CC_MODS_DEBUG).toBeUndefined();
  expect(denyWorkspaceEnvKey("OPENAI_API_KEY")).toBe(true);
  expect(denyWorkspaceEnvKey("PATH")).toBe(false);
});

test("workspaceSpawnEnv overlays Mini TZ/LANG after the strip", () => {
  const env = workspaceSpawnEnv(
    {
      PATH: "/bin",
      HOME: "/Users/me",
      LANG: "zh_CN.UTF-8",
      TZ: "Asia/Shanghai",
      LC_ALL: "zh_CN.UTF-8",
      TERM: "dumb",
      AWS_ACCESS_KEY_ID: "id",
    },
    { TZ: "Asia/Tokyo", LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "3" },
  );
  expect(env.TZ).toBe("Asia/Tokyo");
  expect(env.LANG).toBe("en_US.UTF-8");
  expect(env.LC_ALL).toBeUndefined();
  expect(env.TERM).toBe("xterm-256color");
  expect(env.COLORTERM).toBe("truecolor");
  expect(env.FORCE_COLOR).toBe("3");
  expect(env.PATH).toBe("/bin");
  expect(env.HOME).toBe("/Users/me");
  expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(applyTuiLocale({ LANG: "C", TZ: "Asia/Shanghai" }, { TZ: "UTC" }).LANG).toBeUndefined();
  expect(applyTuiLocale({ LANG: "C" }, { TZ: "UTC" }).TZ).toBe("UTC");
});

test("pinTuiLocale wins over a client direnv TZ", () => {
  const env = pinTuiLocale(
    { PATH: "/bin", TZ: "Asia/Shanghai", LANG: "zh_CN.UTF-8" },
    { TZ: "Asia/Tokyo", LANG: "en_US.UTF-8" },
  );
  expect(env.TZ).toBe("Asia/Tokyo");
  expect(env.LANG).toBe("en_US.UTF-8");
});
