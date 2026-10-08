/**
 * Amu: the MCP servers the market offers (docs/internals/amu-mcp-market.md).
 * The upstream address of every request the market makes comes from here and
 * nowhere else; `allowedOrigins` lists every origin the login may contact.
 */

export type McpMarketAuth =
  | { readonly kind: "none" }
  | {
      readonly kind: "oauth-dcr";
      readonly scopes: ReadonlyArray<string>;
      readonly allowedOrigins: ReadonlyArray<string>;
    };

export interface McpMarketEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly auth: McpMarketAuth;
  /**
   * Shown only once a real login, `initialize`, `tools/list` and a
   * side-effect-free `tools/call` from a Claude and a Codex thread have
   * worked against it (the design's shipping rule).
   */
  readonly verified: boolean;
}

export const MCP_MARKET_CATALOG: ReadonlyArray<McpMarketEntry> = [
  {
    id: "context7",
    name: "Context7",
    description: "ライブラリーやフレームワークの最新の説明書を調べます。ログインは要りません。",
    url: "https://mcp.context7.com/mcp",
    auth: { kind: "none" },
    verified: false,
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "サイトの公開（デプロイ）やプロジェクトの様子を確かめます。",
    url: "https://mcp.vercel.com",
    auth: {
      kind: "oauth-dcr",
      // offline_access: Vercel issues a refresh token only with it.
      scopes: ["openid", "offline_access"],
      allowedOrigins: ["https://mcp.vercel.com", "https://vercel.com", "https://api.vercel.com"],
    },
    verified: false,
  },
  {
    id: "hyperframes",
    name: "HyperFrames",
    description: "HeyGen の HyperFrames で、HTML から動画を作ります。",
    url: "https://mcp.heygen.com/mcp/hyperframes",
    auth: {
      kind: "oauth-dcr",
      scopes: ["openid", "profile", "email"],
      allowedOrigins: ["https://mcp.heygen.com", "https://api2.heygen.com"],
    },
    verified: false,
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Supabase のプロジェクトとデータベースを扱います。",
    url: "https://mcp.supabase.com/mcp",
    auth: {
      kind: "oauth-dcr",
      scopes: [],
      allowedOrigins: ["https://mcp.supabase.com", "https://api.supabase.com"],
    },
    verified: false,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Linear の課題やプロジェクトを読み書きします。",
    url: "https://mcp.linear.app/mcp",
    auth: {
      kind: "oauth-dcr",
      scopes: ["read", "write"],
      allowedOrigins: ["https://mcp.linear.app"],
    },
    verified: false,
  },
  {
    id: "topview",
    name: "topview",
    description: "topview のブラウザー操作を使います。",
    url: "https://mcp-browser.topview.ai",
    auth: {
      kind: "oauth-dcr",
      scopes: ["mcp:tools"],
      allowedOrigins: [
        "https://mcp-browser.topview.ai",
        "https://mcp.topview.ai",
        "https://www.topview.ai",
      ],
    },
    verified: false,
  },
];

export const findMcpMarketEntry = (id: string): McpMarketEntry | undefined =>
  MCP_MARKET_CATALOG.find((entry) => entry.id === id);

/**
 * The name an entry gets in a Claude or Codex MCP config. The suffix is
 * random per Amu installation, so it cannot be a name the user's own
 * settings already use (which Amu would otherwise replace).
 */
export const mcpMarketServerName = (id: string, installSuffix: string) =>
  `amu-mcp-${id}-${installSuffix}`;

/** Whether `url` is HTTPS and on one of the entry's allowed origins. */
export function isAllowedMarketUrl(entry: McpMarketEntry, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const allowed =
    entry.auth.kind === "oauth-dcr" ? entry.auth.allowedOrigins : [new URL(entry.url).origin];
  return allowed.includes(parsed.origin) || parsed.origin === new URL(entry.url).origin;
}
