import { describe, expect, it } from "vite-plus/test";
import { makeNativeDuplicateKeyGuard } from "./NativeDuplicateKeyGuard.ts";

describe("native duplicate key guard", () => {
  it("accepts one initial down per physical press and preserves deliberate double letters", () => {
    const guard = makeNativeDuplicateKeyGuard();
    let text = "";
    for (const letter of "abc aabbcc") {
      const code = letter === " " ? "Space" : `Key${letter.toUpperCase()}`;
      const input = { type: "keyDown", code, isAutoRepeat: false };
      if (!guard.shouldSuppress(input)) text += letter;
      if (!guard.shouldSuppress(input)) text += letter;
      guard.shouldSuppress({ ...input, type: "keyUp" });
    }
    expect(text).toBe("abc aabbcc");
  });
  it("uses physical codes for IME keys rather than the shared Process/229 key", () => {
    const guard = makeNativeDuplicateKeyGuard();
    expect(guard.shouldSuppress({ type: "keyDown", code: "KeyK", isAutoRepeat: false })).toBe(
      false,
    );
    expect(guard.shouldSuppress({ type: "keyDown", code: "KeyK", isAutoRepeat: false })).toBe(true);
    expect(guard.shouldSuppress({ type: "keyDown", code: "KeyA", isAutoRepeat: false })).toBe(
      false,
    );
    guard.shouldSuppress({ type: "keyUp", code: "KeyK", isAutoRepeat: false });
    expect(guard.shouldSuppress({ type: "keyDown", code: "KeyA", isAutoRepeat: false })).toBe(true);
    guard.shouldSuppress({ type: "keyUp", code: "KeyA", isAutoRepeat: false });
    expect(guard.shouldSuppress({ type: "keyDown", code: "KeyA", isAutoRepeat: false })).toBe(
      false,
    );
  });
  it("allows native auto-repeat and starts tracking even when the initial down was elsewhere", () => {
    const guard = makeNativeDuplicateKeyGuard();
    for (let i = 0; i < 5; i++) {
      expect(guard.shouldSuppress({ type: "keyDown", code: "KeyA", isAutoRepeat: true })).toBe(
        false,
      );
    }
  });
  it("clears stale keys when focus leaves or a modifier changes", () => {
    const guard = makeNativeDuplicateKeyGuard();
    const down = { type: "keyDown", code: "KeyV", isAutoRepeat: false };
    guard.shouldSuppress(down);
    guard.reset();
    expect(guard.shouldSuppress(down)).toBe(false);
    guard.shouldSuppress({ ...down, type: "keyUp", code: "MetaLeft" });
    expect(guard.shouldSuppress(down)).toBe(false);
  });
  it("fails open for missing physical codes", () => {
    const guard = makeNativeDuplicateKeyGuard();
    for (let i = 0; i < 3; i++) {
      expect(guard.shouldSuppress({ type: "keyDown", code: "", isAutoRepeat: false })).toBe(false);
    }
  });
  it("does not share pressed keys between windows", () => {
    const a = makeNativeDuplicateKeyGuard();
    const b = makeNativeDuplicateKeyGuard();
    const input = { type: "keyDown", code: "KeyA", isAutoRepeat: false };
    a.shouldSuppress(input);
    expect(b.shouldSuppress(input)).toBe(false);
  });
});
