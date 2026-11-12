import { expect, test } from "bun:test";
import { MODEL_CATALOG } from "../src/model-catalog.js";
import {
  extraFlagsWithModel,
  parseSessionCreateMeta,
  permissionModeFromClientMeta,
  withDeniedAskUserQuestion,
} from "../src/session-create-meta.js";

test("Grok yoloMode / autoMode meta maps onto Claude permission modes", () => {
  expect(permissionModeFromClientMeta({ yoloMode: true, autoMode: false })).toBe(
    "bypassPermissions",
  );
  expect(permissionModeFromClientMeta({ yoloMode: false, autoMode: true })).toBe("auto");
  expect(permissionModeFromClientMeta({ yoloMode: false, autoMode: false })).toBe("default");
  expect(permissionModeFromClientMeta({})).toBeUndefined();
  expect(
    permissionModeFromClientMeta({ yoloMode: true, autoMode: false }, false),
  ).toBe("default");
});

test("session/new meta seeds model, session id, askUserQuestion, and Claude agents", () => {
  const sid = "11111111-1111-4111-8111-111111111111";
  const seed = parseSessionCreateMeta(
    {
      yoloMode: true,
      autoMode: false,
      modelId: "claude-opus-5-5",
      sessionId: sid,
      askUserQuestion: false,
      agentProfile: "explore",
    },
    {
      catalog: MODEL_CATALOG,
      agents: [{ value: "explore" }],
    },
  );
  expect(seed.permissionMode).toBe("bypassPermissions");
  expect(seed.model).toBe("opus");
  expect(seed.preferredSessionId).toBe(sid);
  expect(seed.denyAskUserQuestion).toBe(true);
  expect(seed.agent).toBe("explore");
});

test("session/new meta ignores Grok-only model ids, profiles, and non-UUID session ids", () => {
  const seed = parseSessionCreateMeta(
    {
      yoloMode: false,
      autoMode: false,
      modelId: "grok-4",
      sessionId: "not-a-uuid",
      agentProfile: "grok-build-plan",
    },
    {
      catalog: MODEL_CATALOG,
      agents: [{ value: "explore" }],
    },
  );
  expect(seed.permissionMode).toBe("default");
  expect(seed.model).toBeUndefined();
  expect(seed.preferredSessionId).toBeUndefined();
  expect(seed.denyAskUserQuestion).toBe(false);
  expect(seed.agent).toBeUndefined();
});

test("catalog aliases and default modelId do not force a spawn --model", () => {
  expect(parseSessionCreateMeta({ modelId: "sonnet" }, { catalog: MODEL_CATALOG }).model).toBe(
    "sonnet",
  );
  expect(parseSessionCreateMeta({ modelId: "default" }, { catalog: MODEL_CATALOG }).model).toBeUndefined();
  expect(extraFlagsWithModel({ noChrome: true }, "sonnet")).toEqual({
    noChrome: true,
    model: "sonnet",
  });
  expect(extraFlagsWithModel({ noChrome: true, model: "opus" }, undefined)).toEqual({
    noChrome: true,
    model: "opus",
  });
});

test("askUserQuestion:false is merged into Claude --disallowed-tools", () => {
  expect(withDeniedAskUserQuestion(undefined, false)).toBeUndefined();
  expect(withDeniedAskUserQuestion(["Read"], true)).toEqual(["Read", "AskUserQuestion"]);
  expect(withDeniedAskUserQuestion(["AskUserQuestion"], true)).toEqual(["AskUserQuestion"]);
});
