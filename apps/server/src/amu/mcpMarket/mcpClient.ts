import type { McpMarketEntry } from "./catalog.ts";
import {
  MARKET_USER_AGENT,
  readMarketResponse,
  type MarketResponse,
  type MarketTransport,
} from "./safeFetch.ts";

/**
 * Amu MCP market: the few MCP requests Amu itself makes upstream — the
 * unauthenticated probe that starts discovery, and the `initialize` +
 * `tools/list` check after a login (docs/internals/amu-mcp-market.md).
 */

const PROTOCOL_VERSION = "2025-06-18";
const MAX_RESPONSE_BYTES = 2_000_000;

export const initializeBody = (id: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Amu", version: "1" },
    },
  });

/** The JSON-RPC messages in a JSON or `text/event-stream` body. */
export function jsonRpcMessages(response: MarketResponse): unknown[] {
  const text = response.body.toString("utf8");
  const type = String(response.headers["content-type"] ?? "");
  const parse = (value: string) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  };
  if (!type.includes("text/event-stream")) return parse(text);
  const messages: unknown[] = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data) messages.push(...parse(data));
  }
  return messages;
}

const resultOf = (messages: unknown[], id: number): Record<string, unknown> | undefined => {
  for (const message of messages) {
    if (
      message &&
      typeof message === "object" &&
      (message as { id?: unknown }).id === id &&
      typeof (message as { result?: unknown }).result === "object"
    )
      return (message as { result: Record<string, unknown> }).result;
  }
  return undefined;
};

export async function postMcp(
  transport: MarketTransport,
  entry: McpMarketEntry,
  body: string,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<MarketResponse> {
  const response = await transport(entry, {
    method: "POST",
    url: entry.url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "User-Agent": MARKET_USER_AGENT,
      "Accept-Encoding": "identity",
      ...extraHeaders,
    },
    body,
  });
  return await readMarketResponse(response, MAX_RESPONSE_BYTES);
}

/**
 * `initialize`, `notifications/initialized` and `tools/list` with this
 * token. Resolves with the number of tools, or rejects with the HTTP status.
 */
export async function checkMcpServer(
  transport: MarketTransport,
  entry: McpMarketEntry,
  accessToken: string | undefined,
): Promise<number> {
  const auth: Record<string, string> = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : {};
  const initialized = await postMcp(transport, entry, initializeBody(1), auth);
  if (initialized.status !== 200 || !resultOf(jsonRpcMessages(initialized), 1))
    throw new McpCheckError(initialized.status);
  const sessionId = initialized.headers["mcp-session-id"];
  const session: Record<string, string> =
    typeof sessionId === "string" ? { "Mcp-Session-Id": sessionId } : {};
  await postMcp(
    transport,
    entry,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    { ...auth, ...session },
  );
  const listed = await postMcp(
    transport,
    entry,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    { ...auth, ...session },
  );
  const result = resultOf(jsonRpcMessages(listed), 2);
  if (listed.status !== 200 || !result || !Array.isArray(result.tools))
    throw new McpCheckError(listed.status);
  if (typeof sessionId === "string")
    void transport(entry, {
      method: "DELETE",
      url: entry.url,
      headers: { ...auth, ...session, "User-Agent": MARKET_USER_AGENT },
    })
      .then((response) => response.resume())
      .catch(() => undefined);
  return result.tools.length;
}

export class McpCheckError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`MCP check failed (${status})`);
    this.status = status;
  }
}
