import { describe, expect, it } from "vite-plus/test";

import { switchNoticeText } from "./useSwitchNotice";

const providers = [
  { instanceId: "codex", models: [{ slug: "gpt-6-luna", name: "GPT-6-Luna" }] },
  { instanceId: "claudeAgent", models: [{ slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }] },
] as never;
const luna = { instanceId: "codex", model: "gpt-6-luna" } as never;
const sonnet = { instanceId: "claudeAgent", model: "claude-sonnet-5-5" } as never;
const undo = () => undefined;

describe("switchNoticeText", () => {
  it("names both models when the next send hands over to another AI", () => {
    expect(
      switchNoticeText({ started: true, current: luna, picked: sonnet, providers, undo }),
    ).toBe("次の送信で GPT-6-Luna → Claude Sonnet 5.5 に引き継ぎます");
  });

  it("says nothing for a new thread, the same AI or no explicit pick", () => {
    expect(
      switchNoticeText({ started: false, current: luna, picked: sonnet, providers, undo }),
    ).toBeNull();
    expect(
      switchNoticeText({ started: true, current: luna, picked: luna, providers, undo }),
    ).toBeNull();
    expect(
      switchNoticeText({ started: true, current: luna, picked: null, providers, undo }),
    ).toBeNull();
  });
});
