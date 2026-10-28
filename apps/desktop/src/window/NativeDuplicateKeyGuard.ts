import type { Input } from "electron";

type KeyInput = Pick<Input, "type" | "code" | "isAutoRepeat">;

/** A physical key cannot have two initial downs without an intervening up. */
export function makeNativeDuplicateKeyGuard() {
  const held = new Set<string>();
  const reset = () => held.clear();
  return {
    reset,
    shouldSuppress(input: KeyInput): boolean {
      const code = input.code;
      if (!code) return false;
      // macOS can omit a letter's keyup while Command is held. A modifier
      // transition must not leave that letter blocked on the next shortcut.
      if (/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(code)) {
        reset();
        return false;
      }
      if (input.type === "keyUp") {
        held.delete(code);
        return false;
      }
      if (input.type !== "keyDown") return false;
      if (!input.isAutoRepeat && held.has(code)) return true;
      held.add(code);
      return false;
    },
  };
}
