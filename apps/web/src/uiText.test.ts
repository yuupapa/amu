// @effect-diagnostics nodeBuiltinImport:off - reads the source tree to find stale dictionary keys.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { japaneseUiTextV2 } from "./amu/uiText.v2.ja";
import { draftThreadDisplayTitle, formatUiText, originalUiText, translateUiText } from "./uiText";
import { japaneseUiText } from "./uiText.ja";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

/** Every source file that can put copy on screen: web, desktop, server, packages. */
function readSourceCopy(): string {
  const roots = ["apps/web/src", "apps/desktop/src", "apps/server/src"];
  for (const name of NodeFS.readdirSync(NodePath.join(repoRoot, "packages"))) {
    roots.push(`packages/${name}/src`);
  }
  const chunks: string[] = [];
  const walk = (dir: string) => {
    if (!NodeFS.existsSync(dir)) return;
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !/\.test\.tsx?$|uiText(\.v2)?\.ja\.ts$/.test(entry.name)
      ) {
        chunks.push(NodeFS.readFileSync(path, "utf8"));
      }
    }
  };
  for (const root of roots) walk(NodePath.join(repoRoot, root));
  return normalizeCopy(
    chunks
      .join("\n")
      // "a " + "b" and JSX {" "} spacers read as one sentence on screen.
      .replace(/(["'`])\s*\+\s*\1/g, "")
      .replace(/\{\s*["'] ["']\s*\}/g, " ")
      .replace(/\\n/g, " ")
      .replace(/\\(["'`\\])/g, "$1"),
  );
}

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&amp;": "&",
  "&nbsp;": " ",
};

function normalizeCopy(text: string): string {
  return text
    .replace(/&(?:quot|apos|rsquo|lsquo|amp|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

// Built at runtime or reported by a provider, never written out whole in the source.
const DYNAMIC_KEYS = new Set([
  "Fast mode · Reasoning", // capability labels joined with " · "
  "Quit T3 Code", // `Quit ${displayName}` in the desktop menu
  "Open in the environment's browser", // `Open in ${environmentLabel}'s browser`
  "Extra high", // reasoning effort label from the provider
]);
const isKeybindingCommandLabel = (key: string) => /^[A-Z][A-Za-z ]*: [A-Z]/.test(key);

describe("local Japanese UI", () => {
  it("keeps the original copy available in English", () => {
    expect(translateUiText("Set up T3 Code", "en")).toBe("Set up Amu");
  });
  it("localizes onboarding and primary send actions", () => {
    expect(translateUiText("Set up T3 Code", "ja")).toBe("Amuの初期設定");
    expect(translateUiText("Send message", "ja")).toBe("メッセージを送信");
  });
  it("keeps English search terms available for localized labels", () => {
    expect(originalUiText("接続")).toContain("Connections");
    expect(originalUiText("接続")).toContain("Connect");
    expect(originalUiText("画面のフォント")).toBe("Interface font");
  });
  it("localizes only the generated draft title and preserves saved or custom titles", () => {
    expect(draftThreadDisplayTitle("New thread", true)).toBe(
      translateUiText("New thread", import.meta.env.VITE_T3_UI_LANGUAGE === "en" ? "en" : "ja"),
    );
    expect(draftThreadDisplayTitle("New thread", false)).toBe("New thread");
    expect(draftThreadDisplayTitle("My New thread", true)).toBe("My New thread");
  });
  it("preserves unknown output, file paths and model identifiers", () => {
    for (const text of ["/Users/example/Project", "gpt-6", "codex login", "独自のプロジェクト名"]) {
      expect(translateUiText(text, "ja")).toBe(text);
    }
  });
  it("formats translated copy without translating or reparsing inserted content", () => {
    expect(formatUiText("Failed to copy {0}", ["Settings {1}"], "ja")).toBe(
      "Settings {1}をコピーできませんでした",
    );
    expect(formatUiText("Failed to copy {0}", ["Settings {1}"], "en")).toBe(
      "Failed to copy Settings {1}",
    );
    expect(formatUiText("Comparing {0} against {1}", ["/tmp/Connect", "gpt-6"], "ja")).toBe(
      "/tmp/Connectとgpt-6を比較中",
    );
    expect(formatUiText("{0} {1}", [0], "en")).toBe("0 {1}");
  });
  it("preserves JSX entities in English display copy while keeping unknown content verbatim", () => {
    expect(translateUiText("Unknown &quot;provider&quot; output", "en")).toBe(
      "Unknown &quot;provider&quot; output",
    );
    expect(translateUiText("Don&apos;t show this again", "en")).toBe("Don't show this again");
  });
  it("keeps inline spacing around translated display copy", () => {
    expect(translateUiText(" saving ", "en")).toBe(" saving ");
    expect(translateUiText(" saving ", "ja")).toBe(" 保存中 ");
    expect(translateUiText(" unknown output ", "ja")).toBe(" unknown output ");
  });
  it("shows the app name but keeps real product names", () => {
    expect(translateUiText("Quit T3 Code", "ja")).toBe("Amuを終了");
    expect(translateUiText("T3 Connect settings", "ja")).toBe("T3 Connectの設定");
    expect(translateUiText("T3 system footprint", "ja")).toBe("Amuのシステム使用量");
  });
});

describe("Japanese dictionary", () => {
  // Upstream rewords copy often. A key the source no longer contains never
  // matches, so the reworded text shows in English while the old entry hides it.
  it("has no exact entries for copy the source no longer contains", () => {
    const source = readSourceCopy();
    const stale = Object.keys({ ...japaneseUiText, ...japaneseUiTextV2 }).filter((key) => {
      // Templates fill values in at runtime; their whole text is never in the source.
      if (/\{\d+\}/.test(key) || DYNAMIC_KEYS.has(key) || isKeybindingCommandLabel(key)) {
        return false;
      }
      const copy = normalizeCopy(key);
      return copy.length > 0 && !source.includes(copy);
    });
    expect(stale).toEqual([]);
  });
});
