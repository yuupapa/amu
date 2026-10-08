// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads the names in the user's own Claude and Codex MCP settings, cached for a few seconds.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MCP_MARKET_SERVER_PREFIX } from "./catalog.ts";

/**
 * Amu MCP market: names under `amu-mcp-` are Amu's, but if the user's own
 * Claude or Codex settings already use one, Amu leaves that server out for
 * that AI instead of replacing the user's entry (docs/internals/amu-mcp-market.md,
 * "Injection"). Only the names are read; nothing is changed.
 */

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; names: ReadonlySet<string> }>();

function codexNames(environment: NodeJS.ProcessEnv): Set<string> {
  const home = environment.CODEX_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".codex");
  const names = new Set<string>();
  try {
    const text = NodeFS.readFileSync(NodePath.join(home, "config.toml"), "utf8");
    for (const match of text.matchAll(
      /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gmu,
    )) {
      const name = match[1] ?? match[2] ?? match[3] ?? "";
      if (name.startsWith(MCP_MARKET_SERVER_PREFIX)) names.add(name);
    }
  } catch {
    // No config: nothing taken.
  }
  return names;
}

function claudeNames(environment: NodeJS.ProcessEnv): Set<string> {
  const folder = environment.CLAUDE_CONFIG_DIR?.trim() || NodeOS.homedir();
  const names = new Set<string>();
  const take = (servers: unknown) => {
    if (!servers || typeof servers !== "object") return;
    for (const name of Object.keys(servers))
      if (name.startsWith(MCP_MARKET_SERVER_PREFIX)) names.add(name);
  };
  try {
    const value = JSON.parse(
      NodeFS.readFileSync(NodePath.join(folder, ".claude.json"), "utf8"),
    ) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
    take(value.mcpServers);
    for (const project of Object.values(value.projects ?? {})) take(project?.mcpServers);
  } catch {
    // No config: nothing taken.
  }
  return names;
}

/** The `amu-mcp-` names the user's own settings for this AI already use. */
export function userTakenMarketNames(
  driver: string,
  environment: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): ReadonlySet<string> {
  const cached = cache.get(driver);
  if (cached && now - cached.at < CACHE_MS) return cached.names;
  const names =
    driver === "codex"
      ? codexNames(environment)
      : driver === "claudeAgent"
        ? claudeNames(environment)
        : new Set<string>();
  cache.set(driver, { at: now, names });
  return names;
}
