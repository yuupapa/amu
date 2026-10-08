import { useCallback, useEffect, useRef, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

/**
 * Amu: Settings → 連携 → MCP (docs/user/mcp-market.md). Lists the market's
 * servers; "追加する" connects one (a browser login where needed) and Claude
 * and Codex threads use it through Amu. Only this Mac's desktop app may add
 * or remove; other clients see the status.
 */

type Status = "not_added" | "connected" | "refreshable" | "needs_login" | "unavailable";
interface Card {
  id: string;
  name: string;
  description: string;
  login: boolean;
  verified: boolean;
  status: Status;
  addedAt: string | null;
}

const PATH = "/api/amu/mcp-market";
const SHOW_UNVERIFIED_KEY = "amu:mcp-market:show-unverified";
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 10 * 60_000;

const STATUS_TEXT: Record<Status, string> = {
  not_added: "未追加",
  connected: "接続済み",
  refreshable: "接続済み",
  needs_login: "もう一度ログインが必要",
  unavailable: "一時的に使えません",
};

async function request(body?: { action: "connect" | "remove"; id: string }) {
  const bearer = await readDesktopPrimaryBearerToken();
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(PATH), {
    method: body ? "POST" : "GET",
    credentials: bearer ? "omit" : "include",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const answer = (await response.json().catch(() => ({}))) as {
    result?: Card[];
    canManage?: boolean;
    authorizationUrl?: string | null;
    error?: string;
  };
  if (!response.ok || answer.error) throw new Error(answer.error ?? "読み込めませんでした。");
  return answer;
}

function openInBrowser(url: string) {
  const bridge = (window as { desktopBridge?: { openExternal: (url: string) => unknown } })
    .desktopBridge;
  if (bridge) void bridge.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function McpMarketSettings() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const [showUnverified, setShowUnverified] = useState(() => {
    try {
      return window.localStorage.getItem(SHOW_UNVERIFIED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const answer = await request();
      if (!mounted.current) return answer.result ?? [];
      setCards(answer.result ?? []);
      setCanManage(answer.canManage === true);
      return answer.result ?? [];
    } catch {
      if (mounted.current) setCards((current) => current ?? []);
      return [];
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // While a browser login is open, look again every few seconds.
  useEffect(() => {
    if (waiting === null) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      void refresh().then((list) => {
        const card = list.find((item) => item.id === waiting);
        if (card?.status === "connected" || Date.now() - started > POLL_LIMIT_MS) setWaiting(null);
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, waiting]);

  const act = async (action: "connect" | "remove", card: Card) => {
    setBusy(card.id);
    setMessage(null);
    try {
      const answer = await request({ action, id: card.id });
      if (!mounted.current) return;
      if (answer.result) setCards(answer.result);
      if (action === "connect" && answer.authorizationUrl) {
        openInBrowser(answer.authorizationUrl);
        setWaiting(card.id);
        setMessage({
          id: card.id,
          text: "ブラウザーでログインして許可してください。終わると、ここが「接続済み」に変わります。",
        });
      }
    } catch (cause) {
      if (mounted.current)
        setMessage({
          id: card.id,
          text: cause instanceof Error ? cause.message : "失敗しました。",
        });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const shown = (cards ?? []).filter(
    (card) => card.verified || showUnverified || card.status !== "not_added",
  );
  const hiddenCount = (cards ?? []).filter((card) => !card.verified).length;

  return (
    <SettingsSection id="mcp-market" title="MCP">
      <SettingsRow
        title="追加したサービスを Claude と Codex で使う"
        description="ここで追加したサービスは、Claude と Codex の会話で使えます。これから始める会話で使え、いま開いている会話は Amu を再起動したあとに使えます。ログインは Amu が預かり、会話には渡しません。計画モードや読み取り専用の会話では、ツールの実行は止めます。"
      />
      {!canManage && cards !== null ? (
        <SettingsRow
          title="追加と削除はこの Mac の Amu から"
          description="スマホやブラウザーからは状態の確認だけができます。"
        />
      ) : null}
      {shown.map((card) => {
        const added = card.status !== "not_added";
        const disabled = !canManage || busy !== null;
        return (
          <SettingsRow
            key={card.id}
            title={
              <span className="flex items-center gap-2" translate="no">
                {card.name}
                {!card.verified ? (
                  <Badge variant="outline" translate="yes">
                    確認中
                  </Badge>
                ) : null}
              </span>
            }
            description={
              <>
                {card.description}
                {message?.id === card.id ? (
                  <span className="mt-1 block text-foreground">{message.text}</span>
                ) : null}
              </>
            }
            status={
              <Badge
                variant={
                  card.status === "connected" || card.status === "refreshable"
                    ? "success"
                    : card.status === "not_added"
                      ? "outline"
                      : "warning"
                }
              >
                {waiting === card.id ? "ログインを待っています…" : STATUS_TEXT[card.status]}
              </Badge>
            }
            control={
              <div className="flex gap-2">
                {!added ? (
                  <Button size="sm" disabled={disabled} onClick={() => void act("connect", card)}>
                    追加する
                  </Button>
                ) : (
                  <>
                    {card.login ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => void act("connect", card)}
                      >
                        もう一度ログイン
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => void act("remove", card)}
                    >
                      外す
                    </Button>
                  </>
                )}
              </div>
            }
          />
        );
      })}
      {hiddenCount > 0 ? (
        <SettingsRow
          title="確認中のサービスも出す"
          description="Amu でのログインと動作をまだ確かめ終えていないサービスです。"
          control={
            <Switch
              checked={showUnverified}
              onCheckedChange={(checked) => {
                setShowUnverified(checked);
                try {
                  window.localStorage.setItem(SHOW_UNVERIFIED_KEY, checked ? "1" : "0");
                } catch {
                  // Shown for this visit only.
                }
              }}
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
