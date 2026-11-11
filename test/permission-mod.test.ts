import { expect, test } from "bun:test";
import { answerPermission, bindModChannel, startModChannel } from "../src/mod-channel.js";

test("permission poll returns the ACP client's decision", async () => {
  const channel = startModChannel();
  bindModChannel(channel);
  try {
    const pending = fetch(`http://adapter/permission?id=p1`, { unix: channel.path });
    await Bun.sleep(20);
    answerPermission("p1", "allow_once");
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: "allow_once" });
  } finally {
    channel.stop();
    bindModChannel(undefined);
  }
});

test("question poll can return a declined null answer", async () => {
  const channel = startModChannel();
  try {
    const pending = fetch(`http://adapter/question?id=q1`, { unix: channel.path });
    await Bun.sleep(20);
    channel.answerQuestion("q1", null);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answers: null });
  } finally {
    channel.stop();
  }
});
