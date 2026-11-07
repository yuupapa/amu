import { useState } from "react";
import { amuHelpEntries } from "../../amu/helpContent";
import { useSettingsSearchTarget } from "./settingsLayout";
import { Input } from "../ui/input";

export function AmuHelp() {
  const targetRef = useSettingsSearchTarget<HTMLElement>("amu-help");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const entries = amuHelpEntries.filter((entry) =>
    Object.values(entry).some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
  return (
    <section
      ref={targetRef}
      tabIndex={-1}
      id="amu-help"
      className="mb-6 rounded-lg border border-border p-4"
    >
      <details>
        <summary className="cursor-pointer text-base font-medium">Amuの使い方・ヘルプ</summary>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            できることと、チャットでの頼み方を探せます。使える機能は接続や設定によって異なります。
          </p>
          <label className="block space-y-2">
            <span className="text-sm">機能を検索</span>
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="動画、音声、モデル…"
            />
          </label>
          <p role="status" className="text-xs text-muted-foreground">
            {entries.length}件の案内
          </p>
          {entries.length === 0 && (
            <p className="text-sm">
              該当する機能がありません。検索語を変えるか、入力を消して一覧に戻ってください。
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {entries.map((entry) => (
              <article
                key={entry.title}
                className="min-w-0 space-y-2 rounded-lg border border-border p-4 text-sm"
              >
                <h2 className="font-medium">{entry.title}</h2>
                <p>{entry.description}</p>
                <p className="text-xs text-muted-foreground">頼み方・始め方の例</p>
                <p className="border-l-2 border-border pl-3">{entry.example}</p>
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    必要な準備・使い方
                  </summary>
                  <p className="mt-2">{entry.preparation}</p>
                </details>
              </article>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            使えないときは「今の環境でこの機能を使えるか確認して。必要な接続や準備を教えて」とチャットで頼めます。
          </p>
        </div>
      </details>
    </section>
  );
}
