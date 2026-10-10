# 本家の更新を Amu に取り込む（2026-10-10）

- 作業ブランチ: `sync/upstream-20261010`（`amu-v2` fab552c50 = Amu 0.0.59 から）。作業フォルダー `task/amu-upstream-sync`
- 取り込む本家: `origin/main` 98beed1a2（前回の土台 611132c17 から 293 コミット）
- `amu-v2` とプッシュは、結パパの指示があるまで触らない。結パパの Amu も更新しない

## 目的

本家の 10/7 以降の更新を Amu に入れる。そのあと Amu Creator（`feat/amu-creator`）を重ねる。Creator を先に入れると、本家とぶつかるファイルが 8 個増え、取り込み側が Creator の中身を知らずに直すことになるため、この順にする。

## ぶつかるところ

`git merge --no-commit origin/main` で 24 ファイル・約 42 か所。

| 区分           | ファイル                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 画面           | MessagesTimeline.logic.ts / MessagesTimeline.tsx / session-logic.ts / ChatView.tsx / PreviewView.tsx / SidebarChrome.tsx / settingsLayout.tsx / themePalette.test.ts                                |
| サーバーと部品 | CodexAdapterV2.ts / ClaudeAdapterV2.ts / DesktopBrowserChannel.ts / DesktopTelemetryReceiver.ts / providerMaintenanceRunner.ts / provider-grok・provider-cursor の driver.ts / shared/toolOutput.ts |
| スマホとその他 | mobile threadActivity.ts・.test.ts / ThreadFeed.tsx / DesktopAppIdentity.test.ts / README.md / docs/user/install.md / shared/package.json / pnpm-lock.yaml                                          |

直し方: Amu 側の意図（`git diff 611132c17 amu-v2 -- <file>`）と本家側の意図（`git diff 611132c17 origin/main -- <file>`）を両方残す。どちらかを捨てるときは理由を書く。pnpm-lock.yaml は本家のものを土台に、package.json を直してから入れ直して作る。

## データ

- 本家の新しい移行は 059（McpAppModelContext）と 060（ThreadSnapshotWindowIndexes）。Amu は `amu-v2` で番号つきの移行を足していない（`amuForkMigrations.ts` は旧 55・56 番の台帳行を消すだけ）。番号の衝突はない見込み。取り込み後に、結パパの DB の写し（`env -i` で切り離す）で移行が流れることを確かめる。本物の DB は読まない・書かない。

## 確かめ方

1. 型チェック: 変わったパッケージごと（web / desktop / server / contracts / shared / provider-*/ mobile）。本家の既存のエラーは、本家だけの状態の数と比べる
2. テスト: ぶつかったファイルのテストと、Amu の機能（日本語の画面、ルナのオート、分割画面、アプリ内更新、MCP マーケット、テーマ、生成画像）のテスト
3. Codex のレビュー（コードは変えず指摘のみ）
4. 開発版を起動して、写しのデータで会話・日本語の画面・プレビューを確かめる
5. そのあと Creator を重ね、Creator のテストと短い実機確認をやり直す

## Codex の計画レビューで足したこと（2026-10-10）

- **作業フォルダーの掃除**（Critical）: 本家 0caa95d6e で、`worktreeKeepWhen` が未設定のときの既定が「未コミットの変更があるときだけ残す」になり、無視された `.env` などのある作業フォルダーも消える。Amu は既定を「ローカルのファイルが何かあれば残す」に保つ。既定のままの作業フォルダーで `.env` が残ることをテストで確かめる
- **分割画面**: 本家の会話内検索の Esc が、フォーカスしていない画面にも効く。ほかの全体ショートカットと同じく、フォーカスした画面だけが受けるようにする
- **移った部品**: Grok と Cursor の部品が本家でパッケージに移った。Grok のログイン・ログアウトと、Cursor のログイン前の使用量表示が残っているかを、登録された部品を通して確かめる
- **失敗の比べ方**: エラーやテスト失敗は数ではなく、場所とテスト名で本家 98beed1a2 と比べる
- **Creator の重ね方**: 上流取り込みを確かめてコミットしたあと、Creator の先端（528279661）を rebase ではなく merge で重ねる。Creator の COMMIT 境界・応答の欠落と再起動・設定オフ・撮影・タブの移動の確認をやり直す

### リリースのときに決めること（今回の取り込みでは公開しない）

- **Electron の版**: 本家は 44.4.2 → 44.4.5。Amu のアプリ内更新（`AmuUpdateFeed.ts`）は Electron の版が違うと更新を断るので、次の版はインストーラーでの丸ごとの入れ替えになる。`amu-local.json` などの実行時の設定が残ることを、写しで練習してから出す
- **設定の戻し**: 本家 2c1160783 で設定の `providers` が `providerInstances` に書き換わる。古い版に戻すと一部の設定が読めないおそれがある。更新の前に、設定ファイルも DB と一緒に退避する
- **DB の確かめ**: 旧 55・56 番の台帳、058 までの V2、二度目の起動、途中で止まった移行、旧版と新版の両方で会話が増えた場合を、写しで確かめる
- **試験の切り離し**: `env -i` だけでは Electron のプロファイルが切り離されない。試験用の起動では、サーバーと Electron の保存場所の両方を写しに向け、更新の確認を止め、起動前に使う場所を表示して確かめる

## 戻し方

作業はすべて新しいブランチの上。`amu-v2` も結パパの Amu も変えないので、問題があればブランチを捨てればよい。

## この Mac だけの 0.0.60（2026-10-11）

- 結パパの判断で、上流取り込みと Creator を重ねた `sync/creator-20261011` を 0.0.60 として、この Mac の Amu だけに入れる（GitHub には出さない。`amu-v2` には入れない）
- ビルドには Rust 1.95 以上が要る（本家の resource monitor が sysinfo 0.39.3 を使う）。`RUSTUP_TOOLCHAIN=1.95.0 node scripts/amu-release.mjs --notes-file …`
- 作ったアプリの Info.plist は本家のまま（識別子 com.t3tools.t3code、t3code と http(s) のリンク、Web ページの受け先）。今の Amu は識別子 local.amu.desktop と amu のリンクだけなので、入れる前にそこを今の Amu に合わせた
- Amu.app の Resources には、更新で消してはいけないもの（amu-local.json、tooling/、jev-workflow/）がある。入れ替えではこれらを今の Amu.app から引き継ぐ。手順は `task/amu-local-install/swap-amu.sh`
