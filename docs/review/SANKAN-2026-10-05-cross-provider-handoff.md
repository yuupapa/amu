# 三観レビュー（設計段階）: 一つのチャットでモデルを乗り換える設計書

- 日付: 2026-10-05
- 対象: `docs/internals/cross-provider-handoff.md`（amu ブランチ、HEAD 44429a4e）
- レビュアー: Codex（gpt-6.1-sol, effort high）。静的な読み取りレビューで、コードは変更していない
- 種別: 実装前の設計レビュー。三観（軍配・目付・金継ぎ）を設計段階向けに読み替え、技術的正しさの観点を加えた。実画面の金継ぎ計測と目付のブラウザ観察は、実装前のため未実施
- 以下は Codex の出力の原文

---

軍配（価値・範囲）: Yellow  
目付（使い勝手・導線）: Red  
金継ぎ（表示の一貫性）: Yellow  
技術的正しさ: Red  
全体判定: Red

Claude ↔ Codexに絞るMVPには価値があります。ただし、乗り換えの判定元、送信順序、再起動時の復旧、巻き戻しに実装前の修正が必要です。**Blocker 5件、Major 9件、Minor 1件**です。

`amu`、HEAD `44429a4e`で照合しました。コード・ファイルは変更していません。設計書の12章は、最終確認時の「決定事項」を採用しています。以下の「確認済み」は実コードまたは設計書の事実、「影響」は設計どおり実装した場合の予測です。

## 指摘一覧

### 1. Blocker｜技術｜4章・5.4・7.2：旧プロバイダーを判定する値が送信前に上書きされます

**確認済み**  
webは送信前に次のモデルをスレッドへ保存します。一方、`ensureSessionForThread`は稼働中セッションがなければ、`thread.modelSelection.instanceId`を現在のinstanceとして使います。[ChatView.tsx:5373](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:5373)、[ChatView.tsx:8740](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:8740)、[ProviderCommandReactor.ts:612](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:612)

**影響**  
再起動後のClaudeスレッドでCodexへ送信すると、判定時には「現在も希望先もCodex」になり得ます。白紙のCodexセッションだけが始まり、引き継ぎを見落とします。5.4の旧モデル復元にも同じ問題があります。

**処方**  
現在の担当は永続bindingまたは確定済みセグメントから判断してください。次回の希望モデルと現在の担当を分け、停止済み・再起動後・履歴インポート直後も対象にします。

### 2. Blocker｜技術｜4章・6.5：パケットを作る位置がセグメント作成より前です

**確認済み**  
`:1493`の関数呼び出し内で、`:862`から`ensureSessionForThread`を実行します。6.5は、その呼び出し直前にパケットを付ける指定です。[ProviderCommandReactor.ts:862](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:862)、[ProviderCommandReactor.ts:1493](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1493)

**影響**  
通常の乗り換えでは、パケット作成時に新しい`handoffPending`セグメントがまだありません。4章の「セッション準備後にパケット作成」と矛盾します。

**処方**  
セッション準備後に対象セグメントを読み直し、送信要求へパケットを付けてください。今回のユーザーメッセージはすでに保存されているため、履歴側から除外し、末尾の今回の指示と重複させない仕様も必要です。[decider.ts:1443](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:1443)

### 3. Blocker｜技術・目付｜4章・7.3・7.5：直列実行だけでは再起動耐性と配信判定を成立させられません

**確認済み**  
イベントとprojectionはdispatch内のDBトランザクションで保存しますが、CLI停止・開始・送信はその外側です。また、`sendTurn`はアダプターが入力を受け付けた後にもbinding保存を行います。[OrchestrationEngine.ts:274](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts:274)、[ProviderService.ts:1771](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1771)、[ProviderService.ts:1795](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1795)

**影響**

- 旧cursorを消してからセグメントを保存する前に終了すると、復旧に必要な情報が欠けます。
- 新セッション開始後に終了すると、pendingと実セッションの対応が不明になります。
- CLI受付後、binding保存や`handoff-delivered`保存に失敗すると、「sendTurn失敗だから再送」で同じ作業を二度実行し得ます。

**処方**  
停止前に乗り換えID・旧状態・希望先を永続化し、段階ごとの復旧規則を定義してください。「未送信」「配信済み」に加え、少なくとも「受付不明」を区別します。再試行では同じ操作を継続し、毎回新セグメントを作らない規則も必要です。既存のrecoverと起動時継続処理にも、この状態を反映してください。[ProviderService.ts:1253](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1253)、[serverRuntimeStartup.ts:646](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/serverRuntimeStartup.ts:646)

### 4. Blocker｜技術｜7.4・8章・11章：連続送信と旧セッションの遅延イベントを防げません

**確認済み**  
送信はforkされるため、reactorのイベント処理完了とCLIへの送信完了は一致しません。RuntimeIngestionは`session.exited`を受け入れ、イベント側のproviderでスレッドのセッション状態を書きます。入口で現在のinstanceとの一致を確認していません。[ProviderCommandReactor.ts:1524](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1524)、[ProviderRuntimeIngestion.ts:1838](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1838)、[ProviderRuntimeIngestion.ts:1940](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1940)

**影響**  
最初の送信が`starting`の間に別の送信が進み、pendingパケットを二重に使う可能性があります。旧Claudeの終了通知が新Codex開始後に届けば、新セッションを旧providerの`stopped`状態で上書きし得ます。同じinstanceで再作成した場合は、instance比較だけでも不足します。

**処方**  
同一スレッドの乗り換え・最初の送信・巻き戻しを排他対象にします。`starting`と送信受付待ちもガードへ追加してください。runtimeイベントにはセッション世代との照合を設け、旧世代の状態更新・内容追記・チェックポイント作成を除外します。

### 5. Blocker｜技術・目付｜7.6：巻き戻しの境界判定と再引き継ぎが不正です

**確認済み**  
既存処理はチェックポイントの最大番号から差分ターン数を計算します。Claudeでは全nativeターンを戻すと白紙セッションを作り直します。[CheckpointReactor.ts:793](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:793)、[CheckpointReactor.ts:869](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:869)、[ClaudeAdapter.ts:5333](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:5333)

**影響**  
旧担当が5ターン、新担当が6〜8ターンなら、新セグメントの`start_turn_count`は5です。5まで戻す場合、設計では通常rollbackへ進みます。しかし新担当の最初の引き継ぎ入力も消え、`handoff_pending = 0`だけが残ります。

また、区切りをまたぐ経路にはcursorの破棄、`thread.revert.complete`の順序、削除対象セグメントの処理がありません。番号を再利用するとセグメント範囲が重なります。

**処方**  
開始直前まで戻す場合も再引き継ぎ対象にしてください。native入力の残存状態とAmuターンの対応を明示し、単なる番号差だけで判定しない仕様にします。巻き戻し完了後の記録で新セグメントを作り、旧cursorを使わず開始してください。

さらに、既存のrollback capabilityチェックはファイル復元より前です。白紙開始で代替する経路では分岐が必要です。[CheckpointReactor.ts:808](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:808)

### 6. Major｜技術｜5章・7.3：cursor消去とイベント再生の仕様が不足しています

**確認済み**  
`directory.upsert`では、`resumeCursor: undefined`もプロパティ省略も既存cursorを保持します。消去には明示的な`null`が必要です。runtimePayloadも既存値とマージします。[ProviderSessionDirectory.ts:140](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts:140)、[ProviderSessionDirectory.ts:47](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts:47)

**影響**  
「消す」を省略や`undefined`で実装すると、古いcursorが残ります。5.2の`closed_resume_cursor`も5.1のイベントに含まれないため、projection再構築で復元する根拠がありません。

**処方**  
白紙開始を明示する操作を定義し、cursor・旧runtimePayload・継続マーカーの扱いを固定してください。旧cursorをPhase 1で保存するならイベントに含めます。Phase 3専用なら保存自体を延期できます。

deciderでは、現在のセグメント、重複開始、別セグメントへの配信済み通知、重複通知の規則を定義してください。純粋projectorとSQLのProjectionPipelineの両方への適用が必要です。[commandInvariants.ts:99](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/commandInvariants.ts:99)、[ProjectionPipeline.ts:1953](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1953)

### 7. Major｜技術・金継ぎ｜5.3・5.4・8章：セグメントだけでは発言ごとのモデル名を確定できません

**確認済み**  
Claude・Codexは`in-session`モデル変更に対応します。ターンのチェックポイント番号はnullableです。インポートされたメッセージにも必ずしも通常ターンの対応がありません。[ClaudeAdapter.ts:5589](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:5589)、[CodexAdapter.ts:2805](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/CodexAdapter.ts:2805)、[ProjectionTurns.ts:47](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Services/ProjectionTurns.ts:47)

**影響**  
同一セグメント内でモデルを変えると、5.3では両方の発言に同じモデル名が付きます。実行中の発言も、完了時の番号を待つ設計では即座に判定できません。「既存の全発言は現在のモデルが担当した」と断定する5.4も不正確です。

**処方**  
セグメントはセッション区間として使い、各ターンに担当instance・モデル・セッション世代を保存してください。過去分を確定できない場合は「過去の担当モデル不明」と表示します。

### 8. Major｜技術・軍配｜3章・7.2・8章・9章：追加ガードとPhase 1の対象制限が漏れています

**確認済み**  
G1・G2以外にも、モデル項目のdisabled判定と選択後の拒否があります。[ChatView.tsx:9658](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:9658)、[ChatView.tsx:9725](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:9725)

また、3章の定義は、同一instance・同一continuationKeyで`requiresNewThreadForModelChange`が必要な変更を含みません。現在のコードではこの属性の参照はありますが、具体的なtrue設定は確認できませんでした。

**影響**  
一部の変更はピッカー段階で止まり、別の変更はG3に残ります。反対に、フラグだけで全ドライバーを解除すると、Phase 2未検証の経路も利用できます。

**処方**  
「その変更でnative会話を継続できるか」を共通判定にしてください。Phase 1ではClaude ↔ Codexの許可リストをUI・サーバー双方で適用します。削除済みの旧instanceからの脱出経路も必要です。現在は旧instanceの情報取得で先に失敗します。[ProviderCommandReactor.ts:620](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:620)

Phase 2では長文送信だけでなくrollback非対応も扱う必要があります。Cursor・Antigravity・Grokは非対応を明示しています。[CursorAdapter.ts:1273](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/CursorAdapter.ts:1273)、[AntigravityAdapter.ts:1272](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/AntigravityAdapter.ts:1272)、[GrokAdapter.ts:2219](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/GrokAdapter.ts:2219)

### 9. Major｜技術｜6.3：120,000字の予算計算が最終入力を数えていません

**確認済み**  
上限は120,000ですが、実際にはコンポーザー文脈の展開後、さらに引用展開と添付パスを追加します。[ProviderCommandReactor.ts:1495](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1495)、[ProviderService.ts:1610](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1610)、[ProviderService.ts:1639](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1639)

**影響**  
本文が短くても、文脈や添付を含めると超過します。本文が119,500字なら提示式の予算は負になります。「最初の依頼は必ず残す」とも両立しません。

**処方**  
展開後の今回入力を基準に予算を計算し、下限を0にしてください。設定値も残容量で制限します。最低限の引き継ぎが入らない場合の拒否・縮小方法を決め、切り詰め記号・エスケープ後の長さも計数します。120,000字はAmuの入力制約であり、各モデルの受付保証ではありません。[provider.ts:69](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/provider.ts:69)

### 10. Major｜軍配・技術｜6.1・6.2・10章：引き継ぐべき指示と変更内容が不足します

**確認済み**  
6.1は古い発言から省く一方、6.2は下から削る指定です。会話を古い順に並べるため、後者では最新の訂正を先に失います。コード上では発言本文だけでなく`message.context`も別途保存・展開します。[orchestration.ts:579](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/orchestration.ts:579)、[ProviderCommandReactor.ts:1495](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1495)

**影響**  
「レビューだけ」「公開しない」などの訂正や、選択したコード・ターミナルの根拠を失い得ます。また、過去の変更をコミット済みなら`git diff`だけでは内容を確認できず、A1・A2の期待を保証できません。

**処方**  
最新の訂正を残す削減順序を一本化してください。継続するユーザー指示、現在の目的、未完了作業をどの情報から復元するかを明示します。変更一覧には対象ターン・チェックポイントを付け、累積行数を現在の差分と誤認させない仕様にします。A1・A2にはコミット済み変更と後から訂正した依頼も追加してください。

### 11. Major｜技術｜6.1・6.2・11章：タグと前置きは信頼境界になりません

**確認済み**  
提案では履歴と今回の指示を、同じ`ProviderSendTurnInput.input`文字列へ連結します。別の権限を持つメッセージ構造ではありません。[provider.ts:69](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/provider.ts:69)

**影響・推測**  
閉じタグのエスケープは構造の混乱を減らしますが、「履歴内の命令を実行しない」保証にはなりません。反対に「今回の発言だけが指示」とすると、正当に継続すべき過去のユーザー制約も無視され得ます。

**処方**  
ユーザー指示と、assistant・tool由来の未信頼データを区別してください。パス・プラン・activity summaryもエスケープ対象です。6.2の説明文自身に生の閉じタグが含まれる点も修正が必要です。実際のツール権限はruntime側で維持し、悪意ある履歴を含む検証を追加してください。

### 12. Major｜目付・技術｜7.4・7.5・8章：予約・キュー・失敗後の操作が定義されていません

**確認済み**  
既存キューは送信時のモデル設定を保持します。compaction中の送信は、`ensureSessionForThread`へ到達する前にサーバー側でキューへ入ります。[ChatView.tsx:8098](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:8098)、[sendQueuedMessage.ts:194](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/chat/sendQueuedMessage.ts:194)、[ProviderCommandReactor.ts:1483](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1483)

**影響**  
チップの×を押しても、すでにキューへ移った乗り換えは取り消せません。compaction中に「拒否する」仕様もそのままでは実行されません。同じスレッドを二つのペインで開いた場合、共有draftとキューを変更し合う可能性があります。

**処方**  
「未送信の選択」「キュー待ち」「乗り換え中」「失敗」を区別してください。取消可能な範囲、再送時に元の発言を再利用するか、旧モデルへ戻る操作を明示します。ユーザー入力待ち・compaction中もUIの制御対象に追加し、同一スレッドの別ペイン・別端末からの変更を見えるようにしてください。

### 13. Major｜技術・目付｜7.1・8章・9章・10章：受入条件が主要な失敗経路を覆っていません

**確認済み**  
A6は送信前の予約状態の再起動だけです。A8も既存動作への復帰だけです。既存の起動処理には、実行中スレッドを自動継続する別経路があります。[serverRuntimeStartup.ts:481](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/serverRuntimeStartup.ts:481)

**影響**  
A1〜A8を通っても、途中終了・受付不明・巻き戻し境界・二重送信は未検証です。乗り換え途中でフラグをoffにした場合、pending状態を完了できない可能性も残ります。

**処方**  
Phase 1の必須条件へ次を追加してください。

- 停止・cursor変更・開始・送信受付・配信済み保存の各境界での終了と再起動
- 停止失敗、開始失敗、CLI受付後のDB失敗
- `start_turn_count`の直前・同値・直後への巻き戻しと、その後の再送
- 連続送信、compactionキュー、別ペイン・別端末、旧イベントの遅延到着
- 長い本文、文脈、添付、予算0、インポート履歴、projection再構築
- pending中と乗り換え済みスレッドでのフラグoff、旧クライアント・モバイルからの送信

モバイルUIを非ゴールにする判断は妥当ですが、新しい状態を持つ同じスレッドへのアクセス方針はMVPで必要です。

### 14. Major｜技術・金継ぎ｜6.4・6.6・8章：履歴の読取り量と配信量がパケット上限では制限されません

**確認済み**  
既存の詳細取得は全メッセージを読みます。reactorの既存ヘルパーは`activityKinds: []`を指定するため、ツール・エラーactivityは取得しません。一方、提案したpayloadは現在のactivity投影ではそのままクライアントへ渡ります。[ProjectionSnapshotQuery.ts:1404](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1404)、[ProviderCommandReactor.ts:534](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:534)、[ActivityPayloadProjection.ts:433](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/ActivityPayloadProjection.ts:433)

**影響**  
既存ヘルパーを流用するとパケットのツール・エラー欄が欠けます。全履歴取得へ切り替えると、長いスレッドでは最大6万字の出力のために大量の記録を読みます。パケット全文をactivityへ入れると、乗り換えを繰り返したスレッドのsnapshotも肥大化します。

**処方**  
最初の依頼・最新プラン・必要なactivity・最近の会話を取得する専用クエリを定義してください。通常配信は件数・字数・識別子に限定し、全文は「内容を見る」で取得します。

### 15. Minor｜金継ぎ｜8章：担当表示が重複し、同じドライバー内の乗り換えを区別できません

**確認済み**  
既存タイムラインは途中のassistant発言とツール履歴をまとめ、最終応答のメタ情報を別に扱います。[MessagesTimeline.logic.ts:645](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/chat/MessagesTimeline.logic.ts:645)、[MessagesTimeline.tsx:1741](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:1741)

**影響・設計上の懸念**  
すべてのassistant発言にモデル名を足すと、ツール実行の合間にも同じ名前が並びます。モデル名とdriver名だけでは、同じモデルの別instanceへの切替を区別できません。失敗時にも「ここから新モデル」と表示すると、実際の担当と食い違います。

**処方**  
担当名はターン単位または最終応答の既存メタ領域にまとめてください。区切り線は確定した乗り換えごとに一つとし、必要時にinstance名を表示します。予約・失敗表示は確定した区切りと分け、省略件数や添付の扱いは展開時に示します。

## 設計書のfile:line引用で誤っていたもの

**別のコードを指している数値引用は見つかりませんでした。** 以下は実コードを開いて確認済みです。

| 引用対象                                            | 照合結果                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `orchestration.ts:574 / :590 / :661 / :1541 / :165` | 各スキーマ・履歴import・上限値と一致します                          |
| `ProviderSessionRuntime.ts:36`                      | スキーマと一致し、1スレッド1行もmigrationで確認しました             |
| `ChatView.logic.ts:1015`                            | `deriveLockedProvider`と一致します                                  |
| `ChatView.tsx:9688`                                 | G2のdriver比較条件です。関数宣言は`:9675`ですが、引用箇所は有効です |
| `ProviderCommandReactor.ts:540 / :688–706 / :1493`  | G3・G4・送信要求構築の呼び出しと一致します                          |
| `ProviderService.ts:1463–1482`                      | G4'と一致します                                                     |
| `CheckpointReactor.ts:871`                          | `rollbackConversation`呼び出しと一致します                          |

ただし、コードの説明には次の訂正が必要です。

| 設計書                                          | 訂正内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.5の`:1493`直前への注入                        | セッション準備前になります。指摘2の順序へ修正が必要です                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7.7のLunaを「同じdriverに絞ったまま」           | 現行は開始前の新規依頼だけに提供され、候補は複数driverです。継続チャットでの自動乗り換えは現在提供されていません。[ChatView.tsx:7615](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:7615)、[ChatView.tsx:7646](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:7646)、[ChatView.tsx:9826](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/components/ChatView.tsx:9826) |
| 11章の既存変更を「ガード分岐と注入1か所」に限定 | runtime取り込み、復旧、巻き戻し、両projector、契約、キューにも変更が必要です                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 見送った項目と理由

- **Claude ↔ Codex限定、機械的切り詰め、初回だけの説明**  
  最新12章の決定を尊重します。この方向性自体に反対する根拠はありません。
- **Jevの再利用**  
  無効化されていることを確認しました。今回の会話継続を直接代替するものではありません。[jev.ts:7](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/web/src/lib/jev.ts:7)
- **旧providerへのnative resume、LLM要約、AIの同時実行**  
  MVPに必須ではありません。Phase 3以降への延期は妥当です。
- **実画面の色・余白・文字サイズの断定、各CLIの長文受付保証**  
  未実装の設計レビューでは確認できません。表示上の指摘は設計上の懸念として記載しました。
- **ブラウザ操作、実アプリ起動、テスト・ビルドの実行**  
  今回は静的な読み取りレビューに限定しました。動作確認済みとは扱っていません。

## 結パパへの判の問い

1. 区切りをまたいで巻き戻した後も、設計どおり「現在選んでいるモデル」で続けますか。それとも、戻り先を担当したモデルへ戻しますか。
2. 文字数上限で必須の引き継ぎを入れられない場合、理由を示して乗り換えを止める扱いでよいですか。

---

# 第2巡（設計書 第2版に対するレビュー）

- レビュアー: Codex（gpt-6.1-sol, effort high）。静的な読み取りレビュー
- 以下は Codex の出力の原文

| 観点                   | 信号色  |
| ---------------------- | ------- |
| 軍配（価値・範囲）     | Yellow  |
| 目付（使い勝手・導線） | Red     |
| 金継ぎ（表示の一貫性） | Yellow  |
| 技術的正しさ           | Red     |
| **全体判定**           | **Red** |

第2版では、判定元の分離、注入位置、担当表示、信頼の区別を改善しています。ただし、復旧時の段階遷移、ロックの保持範囲、巻き戻しの永続化、イベントの世代識別は、実装前に修正が必要です。

前回15件は、**解消4件・一部解消11件・未解消0件**です。第2版の具体化によって新たに確認した指摘は、**Blocker4件・Major7件・Minor1件**です。

`amu`、HEAD `44429a4e545afd1379f1e787f9214b0ca196a85e`で静的に照合しました。コード・ファイルは変更していません。以下の「確認済み」は設計書と実コードの事実、「影響」は設計どおり実装した場合の予測です。

## 前回指摘15件の解消状況

| 前回                            | 判定     | 理由                                                                                                                                                                                       |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1・旧担当の判定元              | 解消     | 3.1・7.2で永続bindingと稼働セッションを使い、次回の希望モデルと分離しました。現行の問題箇所`ProviderCommandReactor.ts:612`を置換する方針です。                                             |
| R2・注入順序と今回発言の重複    | 解消     | 6.5で`ensureSessionForThread`終了後に移し、6.2で`triggerMessageId`を除外しています。`:862`と`decider.ts:1443`の処理順に合っています。                                                      |
| R3・永続化と受付判定            | 一部解消 | 操作ID、段階、受付不明を追加しました。ただし、操作前の記録と操作後の記録が混在し、復旧表と遷移規則が両立していません。新規N1です。                                                         |
| R4・連続送信と遅延イベント      | 一部解消 | 排他と世代照合を追加しました。しかし、forkへのロック移譲と世代を付ける位置が未確定です。CheckpointReactorの独立購読も残ります。N2・N4です。                                                |
| R5・巻き戻し境界                | 一部解消 | `T ≤ S`、cursor消去、再引き継ぎを明記しました。ただし、復旧情報を作る時期と既存処理の途中失敗への対応が不足しています。N3です。                                                            |
| R6・cursor消去とイベント再生    | 一部解消 | 明示的`null`、runtimePayload置換、旧cursor保存の延期、両projector対応を明記しました。一方、パケット本文の再構築元と復旧時の世代更新規則がありません。N1・N6です。                          |
| R7・ターン担当の確定            | 一部解消 | セグメントからの推測をやめ、過去分を不明扱いにしました。ただし、担当値を稼働セッションから取得するだけではイベント再生で復元できません。N5です。                                           |
| R8・追加ガードと対象制限        | 一部解消 | G2'、許可リスト、モデル変更属性、Phase 2のrollback非対応を追記しました。ただし、削除済みinstanceは既存`stopSession`でも失敗します。`ProviderService.ts:2086`→`:1352`の例外経路が必要です。 |
| R9・最終入力の予算              | 一部解消 | 展開後の今回入力、予算0、最終字数計数を定義しました。ただし、展開処理と`preExpanded`で省く処理の境界が曖昧です。N7です。                                                                   |
| R10・指示と変更内容             | 一部解消 | 削減順序、訂正、コミット済み変更のテストを追加しました。ただし、二つのrefの差から作業履歴・コミット一覧は復元できません。文脈本文も引き続き省略します。N8です。                            |
| R11・信頼境界                   | 解消     | ユーザー指示と未信頼データを区別し、エスケープ範囲、runtime権限、悪意ある履歴のテストを明記しました。14章では文字列による区別の限界も認めています。                                        |
| R12・予約、キュー、失敗後の操作 | 一部解消 | 表示状態と取消範囲を追加しました。しかし、retryableの操作に対応するクライアントコマンドと、圧縮中キューの取消・表示が不足しています。N9・N10です。                                         |
| R13・失敗経路の受入条件         | 一部解消 | 段階別終了、受付後DB失敗、境界巻き戻し、フラグoffを追加しました。ただし、操作成功後から段階保存前の終了、ロック待機、別端末、サーバーキュー取消を明示していません。A9にも矛盾があります。  |
| R14・読み取り量と配信量         | 一部解消 | 専用クエリ、本文の別取得、activityの小型化は改善です。一方、ユーザー発言全件を読むため、読み取り量は依然として無制限です。N11です。                                                        |
| R15・担当表示の重複             | 解消     | 最終応答のメタ情報へ集約し、区切りをS5で確定、同名モデルの別instanceを補足する仕様になりました。引用位置の訂正だけ必要です。                                                               |

## 新規指摘一覧

### N1・Blocker｜技術・目付｜4章・5.2・9.1

段階の意味と復旧時の遷移が一致しません

**確認済み**  
4章では停止・開始・送信を行った段階をS1・S2・S4としています。一方、9.1ではS4を送信した可能性のある状態として扱います。5.2は「一段先だけ」「同じ段階は無視」としていますが、復旧表ではS2を世代更新付きで再実行し、S3からS2を再実行します。

CLI受付とDB保存は別処理です。[ProviderService.ts:1771](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1771)、同`:1795`、`OrchestrationEngine.ts:274`。

**影響**  
S3の記録が残ったままCLI受付後に終了すると、9.1に従って自動再送し得ます。S2の重複を無視すると更新した世代を記録できず、S3からの後退はdeciderに拒否されます。

**処方**  
段階を「操作予定の永続化」と「操作結果」に分けてください。送信予定はCLI呼出し前に保存します。復旧による再作成は`attemptId`などで区別し、段階を戻さず世代とセッション対応を更新する規則が必要です。

### N2・Blocker｜技術・目付｜9.3・7.4

ロック待機でworkerを止める可能性があります

**確認済み**  
ProviderCommandReactorは一つのworkerでイベントを処理します。[ProviderCommandReactor.ts:1889](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1889)、`packages/shared/src/DrainableWorker.ts:47`。送信は`:1524`でforkします。圧縮後の送信は`:349`で同じreactorへ再要求し、`:369`で`Deferred`を待ちます。

設計はS5までのロック保持を要求する一方、巻き戻し後はS1で次のユーザー送信を待ちます。

**影響・条件付き**  
worker内で次の送信のロック取得を待つ実装なら、別スレッドの停止・承認応答まで滞留します。圧縮後の再要求を待つ間もロックを保持すれば、再要求側が同じロックを取得できずデッドロックします。巻き戻し後のユーザー待ちまで保持する実装も成立しません。

**処方**  
ロックの取得者、forkへの移譲、失敗・中断時の解放を定義してください。workerでは長時間の取得待機を行わず、圧縮後の再要求とユーザー判断待ちでは解放します。CheckpointReactor・起動復旧からも同じ排他を使える構成が必要です。

### N3・Blocker｜技術・目付｜7.4

巻き戻しの復旧情報を不可逆な処理の後で作っています

**確認済み**  
新手順はファイル復元、セッション停止、`revert.complete`、セグメント無効化の後でS0を作ります。既存処理は復元後にnative rollback、古いref削除、`revert.complete`の順です。[CheckpointReactor.ts:849](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:849)、同`:871`・`:884`・`:891`。完了dispatchの失敗は`:900`でactivityへ変換します。

また、S0には`triggerMessageId`が必須ですが、巻き戻し直後には次の発言がありません。

**影響**  
`revert.complete`後からS0作成前に終了すると、再引き継ぎ待ちを復旧できません。既存のエラー変換を残すと、完了記録に失敗しても後続手順を進め得ます。会話だけを戻す`restoreFiles: false`の扱いも明記されていません。

**処方**  
復元前に、戻り先・希望モデル・操作IDを保存してください。復元、停止、ref整理、会話とセグメントの更新を段階化し、完了保存の成功を確認して進めます。巻き戻し由来の操作ではmessageIdを未設定にでき、次回送信時に一度だけ関連付ける仕様が必要です。

### N4・Blocker｜技術｜7.5

受信時の世代付与とIngestionだけの照合では不足します

**確認済み**  
イベント共通契約には世代とネイティブセッションIDがありません。[providerRuntime.ts:202](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/providerRuntime.ts:202)、同`:47`。Claudeの終了イベントは`providerRefs: {}`です。`ClaudeAdapter.ts:4349`。Codexの共通変換もセッションIDを補いません。`CodexAdapter.ts:986`。

ProviderServiceはinstance単位のストリームを購読します。`ProviderService.ts:1232`。CheckpointReactorはIngestionとは別に同じイベントを購読します。[CheckpointReactor.ts:1040](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:1040)。

**影響**  
中継時に現在世代を付けるだけでは、キューに残った旧イベントへ新世代を付けてしまいます。Ingestionで拒否してもCheckpointReactorには届き、旧`session.exited`で現在の管理状態を消し得ます。ProviderService自身にも配信前のbinding更新があります。`:1129`。

**処方**  
アダプターのセッションコンテキストから、イベント生成時に不変の世代を付けてください。ProviderServiceの副作用・配信より前に照合し、すでに配信されたイベントについては各consumerでも確認します。新規開始とnative resumeで世代をどう扱うかも統一が必要です。

### N5・Major｜技術・金継ぎ｜5.4・8.4

担当列は追加できますが、値の確定元が再生可能ではありません

**確認済み**  
`thread.turn-start-requested.modelSelection`は任意です。`decider.ts:1471`。現行SQL projectorは要求時にpending行を作り、後の`thread.session-set`でturnIdと関連付けます。[ProjectionPipeline.ts:1388](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1388)、同`:1445`・`:1550`。そのsessionイベントにはmodelとgenerationがありません。`packages/contracts/src/orchestration.ts:619`。

**影響**  
稼働セッションを参照して列を書くだけでは、projection再構築時に同じ値を得られません。乗り換え前の要求時点では旧セッションしかなく、希望モデルと実行担当も一致するとは限りません。

**処方**  
実行担当の確定イベントへ、messageId・turnId・instance・解決済みモデル・generationを保存してください。列追加に加え、pending行からの関連付け、repository、snapshotと配信契約、両projectorを更新します。実行中のsteeringが同じturnIdを使う場合の担当表示も決める必要があります。`ClaudeAdapter.ts:5151`。

### N6・Major｜技術｜5.1・5.3・11章

パケット本文をprojectionだけに保存すると再構築できません

**確認済み**  
5.1のイベントには`packetId`しかなく、5.3では本文を`projection_thread_handoff_packets`にだけ置きます。既存projectorはイベントストアから再生します。[ProjectionPipeline.ts:2068](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:2068)。

**影響**  
projectionを作り直すと、保存済みパケットの同一本文を復元できません。現在の履歴から再生成しても、巻き戻し、添付情報、展開処理の変更で送信済み本文と異なり得ます。11章の再構築テストと矛盾します。

**処方**  
本文をイベントに保存するか、再構築対象外の永続artifactに保存し、イベントから不変のID・hashで参照してください。通常snapshotへ本文を出さない方針は、そのまま維持できます。

### N7・Major｜技術｜6.3・6.5

`preExpanded`で省く処理の範囲が未定義です

**確認済み**  
現行sendTurnは引用展開、添付パス、画像に付随するcaptured-window情報を順に追加します。[ProviderService.ts:1610](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1610)、同`:1639`・`:1664`。入力のschema検証は`:1596`で先に行います。

設計の予算計算ではcaptured-window情報を明示せず、6.3は展開関数を両方から使う、6.5は`preExpanded`で二重展開を避ける、としています。

**影響・実装次第**  
引用だけを省けば添付文脈が二重追加されます。添付処理をまとめて省けば、未展開の画像付随情報を失い得ます。履歴を連結してから引用展開すると、履歴内の引用まで展開し、計数済み予算から外れます。

**処方**  
今回入力だけを一度展開する関数を定義し、必要な設定値を引数で渡してください。画像付随情報も含め、その後にエスケープとパケット構築を行います。`preExpanded`は内部入力として契約化し、添付のnative送信と最終入力検証は省かない仕様にします。

### N8・Major｜軍配・技術｜6.2・6.4

ref比較で得られる差分と作業履歴を混同しています

**確認済み**  
ref間の内容比較自体は妥当です。ただし、開始前の基準は番号0のrefで、初回の完了チェックポイントとは別です。[CheckpointReactor.ts:699](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:699)。既存の全スレッド差分も番号0を指定します。`CheckpointDiffQuery.ts:261`。

チェックポイントは親指定なしの`commit-tree`で作られます。[GitVcsDriver.ts:1025](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/vcs/GitVcsDriver.ts:1025)。差分取得は二つのcommitの内容比較です。`:1165`。

**影響**  
「最初」を最初の完了refと解釈すると、最初の修正を失います。途中で変更して元に戻した内容、実際のコミット一覧、最後に変更したターンは二つのrefだけでは分かりません。最新ref以降の手作業も含まれません。

**処方**  
番号0から最新の正常なrefまでを「開始前から最新チェックポイントまでの最終差分」と定義してください。最終変更ターンは各ターンの差分記録から取得し、コミット一覧には別の取得元が必要です。基準refなし・チェックポイントなしの場合は取得不能と明示します。

### N9・Major｜目付・技術｜5.1・5.2・8.2・9.2

retryableのボタンに対応する操作がありません

**確認済み**  
8.2にはretryableの「もう一度試す」「元のモデルに戻る」があります。しかし、クライアントから使える新コマンドは`resolve`だけで、5.2ではunknown-deliveryにしか許可しません。

通常送信へ流用すると、新しい要求として処理されます。`ProviderCommandReactor.ts:1218`。既存の再要求では、messageIdを再利用する専用経路を設けています。[ProviderCommandReactor.ts:343](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:343)。

**影響**  
表示したボタンを実行できないか、通常送信で別操作を作ることになります。discard後の新セッション、パケット、保存済み発言の処理も未定義です。

**処方**  
retryableの再試行・終了・旧担当への再引き継ぎに対応するコマンドと受付条件を追加してください。unknown-deliveryのresendではセッション再確保も定義し、通常の新規送信と分離します。

### N10・Major｜目付・技術｜6.2・6.4・7.3・8.2

二種類のキューを同じ表示・取消仕様で扱っています

**確認済み**  
`sendQueuedMessage.ts:194`はクライアント側キューの送信設定です。一方、圧縮中キューはサーバーのMapに保存します。[ProviderCommandReactor.ts:1483](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1483)、同`:257`。サーバーキューはユーザー発言の保存後に入り、再要求で同じmessageIdを使います。`decider.ts:1443`、`ProviderCommandReactor.ts:343`。

6.4はユーザー発言全件を読み、除外対象は今回のmessageIdだけです。

**影響**  
サーバーキューへ移った送信を、クライアントの項目削除だけでは取り消せません。最初の乗り換えパケットに、後続の未送信メッセージまで「過去の有効な指示」として入り、後から再び送られる可能性があります。

**処方**  
両キューの状態、取消コマンド、再起動時の扱いを分けて定義してください。パケットの取得範囲には要求時点の境界を設け、後続の未送信・取消済み発言を実行済み履歴と区別します。

### N11・Major｜技術・軍配｜6.4

専用クエリでも読み取り量が無制限です

**確認済み**  
6.4はユーザー発言全件を読み、各本文を6,000字に制限します。件数と合計字数の制限はありません。現行の全件クエリにも件数制限はありません。[ProjectionSnapshotQuery.ts:1404](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1404)。

**影響**  
出力を6万字に制限しても、読み取り・転送・組み立ての負荷は発言件数に比例します。9.3のロック内で実行すれば、乗り換えの待ち時間も増えます。

**処方**  
最初の依頼を別取得し、残りは新しい順に件数・合計字数を制限して取得してください。本文の切り詰めはDB側で行い、省略件数は本文を読まない集計で取得します。

### N12・Minor｜目付・技術｜7.4・11章A9

A9の戻り先と期待結果が一致しません

**確認済み**  
7.4では`T > S`を通常rollbackとします。A9の「乗り換えた直後のターンまで」は、最初の新担当ターンを残す`T = S + 1`とも読めますが、期待結果は再引き継ぎです。現行rollbackは戻り先との差を使います。[CheckpointReactor.ts:869](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:869)。

**影響**  
同じ手順を、通常rollback成功とも再引き継ぎ不足とも判定できます。

**処方**  
A9の戻り先を「乗り換え前の最後のターン、`T = S`」と明示し、`T = S + 1`は通常rollbackとして別の期待結果にしてください。

## 誤っていたfile:line引用

指定された引用はすべて開いて照合しました。**数値の引用先が説明と異なるものは、`MessagesTimeline.tsx:1741`です。**

| 引用                                                                 | 照合結果                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessagesTimeline.tsx:1741`                                          | assistant本文の`AssistantTimelineRow`呼出しです。メタ情報の分岐は`:1747`、実体は`:2437`、メタ表示本体は`:2455`です。8.4の引用を訂正してください。 |
| `ChatView.tsx:5373 / :8740`                                          | メタ更新の判定・送信前の設定保存と一致します。                                                                                                    |
| `ChatView.tsx:9658 / :9725`                                          | disabled理由・選択後の拒否判定と一致します。                                                                                                      |
| `ChatView.tsx:7615 / :7646 / :9826`                                  | Lunaの開始前判定・候補取得・提供条件と一致します。                                                                                                |
| `ProviderCommandReactor.ts:534 / :612 / :620 / :862 / :1483 / :1524` | detail取得、現在instanceのfallback、旧instance照会、session準備、圧縮中キュー、fork送信と一致します。                                             |
| `ProviderService.ts:1253 / :1610 / :1639 / :1771 / :1795`            | recover、引用展開、添付パス追加、adapter送信、受付後binding保存と一致します。                                                                     |
| `ProviderSessionDirectory.ts:47 / :140`                              | runtimePayloadマージ・cursor保持規則と一致します。                                                                                                |
| `ProviderRuntimeIngestion.ts:1838 / :1940`                           | 終了イベントの許可・イベント側providerによるsession更新と一致します。                                                                             |
| `OrchestrationEngine.ts:274`                                         | DBトランザクションと一致します。                                                                                                                  |
| `serverRuntimeStartup.ts:481 / :646`                                 | 起動時reconcileと自動継続条件です。ただし`:646`はcursor非nullなどが条件で、S0・S1復旧の入口にはそのまま使えません。                               |
| `CheckpointReactor.ts:808`                                           | ファイル復元前のrollback capability判定と一致します。                                                                                             |
| `decider.ts:1443`                                                    | ユーザー発言保存イベントと一致します。                                                                                                            |
| `sendQueuedMessage.ts:194`                                           | キュー送信時のモデル設定と一致します。サーバーの圧縮中キューを指す引用ではありません。                                                            |
| `ProjectionSnapshotQuery.ts:1404`                                    | メッセージ全件取得と一致します。                                                                                                                  |
| `ProjectionPipeline.ts:1953`                                         | projector登録一覧です。新しいprojectorの登録場所という引用なら有効です。実際の適用処理は`:2085`以降です。                                         |

## 見送った項目と理由

- **Claude ↔ Codex限定、機械的切り詰め、巻き戻し後は現在選択中のモデルで継続**  
  12章の決定を尊重します。方針そのものを変更する指摘はしていません。
- **projection_turnsへの列追加、ref間差分取得、純粋な展開関数の抽出**  
  いずれも実現可能です。指摘対象は、値の永続化元・差分の意味・処理境界です。
- **実際のツール実行済み判定と完全な配信保証**  
  turnIdの返却だけでは保証できません。設計の「受付不明をユーザー判断へ回す」方向は妥当です。
- **画面の色・余白、CLIの6万字受付、実際のデッドロック再現**  
  未実装のため確認していません。ブラウザ、アプリ、テスト、ビルドは実行せず、条件付きの予測として記載しました。
- **Phase 3以降のnative resume・要約・並行実行**  
  今回のMVPを成立させるために必要な範囲へ限定しました。

## 結パパへの判の問い

1. 12章の仮決定どおり、必須パケットが入らない場合は、理由を表示して乗り換えを止める扱いで確定しますか。
2. 受付不明で「送らずに閉じる」を選んだ発言は、タイムラインに「受付不明・再送なし」として残す扱いでよいですか。

---

# 第3巡（設計書 第3版に対するレビュー）

- レビュアー: Codex（gpt-6.1-sol, effort high）。静的な読み取りレビュー
- 以下は Codex の出力の原文

| 観点                   | 信号色  |
| ---------------------- | ------- |
| 軍配（価値・範囲）     | Yellow  |
| 目付（使い勝手・導線） | Red     |
| 金継ぎ（表示の一貫性） | Yellow  |
| 技術的正しさ           | Red     |
| 全体判定               | **Red** |

第3版では、送信予定の事前保存、パケット本文のイベント保存、巻き戻しの制限が改善されています。ただし、再試行の遷移、失敗後の受付条件、送信拒否時の副作用に矛盾があります。第3巡の指摘は**Blocker 5件・Major 6件・Minor 1件**です。

`amu`、HEAD `44429a4e545afd1379f1e787f9214b0ca196a85e`で静的に照合しました。コード・ファイルは変更していません。「確認済み」は設計書または実コードの事実、「影響」はその仕様を実装した場合の予測です。解消判定は、実装完了ではなく設計上の解消を意味します。

## 前回指摘の解消状況

対象23件は、解消8件・一部解消15件・未解消0件です。

| 指摘                            | 判定     | 理由                                                                                                                                               |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1・段階遷移と復旧              | 一部解消 | 送信前の`submit-planned`保存と試行番号を追加しました。ただし、開始し直す復旧と段階の単調増加、受付不明後の再開始条件が両立していません。P1です。   |
| N2・workerとロック待機          | 一部解消 | ロック待機による問題は解消しました。ただし、圧縮経路ではセッション準備もfork側で実行され、9.3の直列処理の前提が成立しません。P4です。              |
| N3・境界巻き戻しの復旧情報      | 解消     | 境界を越える巻き戻し自体を禁止したため、その後の再引き継ぎを復旧する手続きは不要になりました。操作中の競合は別途P5です。                           |
| N4・イベントの世代識別          | 一部解消 | 生成時の付与と各consumerでの照合を明記しました。ただし、アダプター内部の再開始、直接recover、開始イベントとbinding更新の順序が未整理です。P6です。 |
| N5・担当記録の再生可能性        | 一部解消 | 担当値をイベントに保存する方針は解消しました。pending行の置換・削除を考慮した関連付けは不足しています。P7です。                                    |
| N6・パケット本文の再構築        | 解消     | 本文とhashをイベントへ保存するため、現在の履歴から再生成せず同じ本文を復元できます。                                                               |
| N7・展開処理の境界              | 解消     | 4種類のテキスト展開、内部フラグ、ネイティブ添付、最終検証を分けました。reactor側の文脈展開も移す必要がありますが、抽出は実現可能です。             |
| N8・差分と作業履歴の混同        | 解消     | 番号0からの最終差分と定義し、コミット一覧を除外しました。途中で戻した変更と手作業を含まない旨も明示しています。                                    |
| N9・retryableの操作             | 一部解消 | retry・abortコマンドを追加しました。ただし、操作を再開できる状態と、新規送信を断る状態の定義に矛盾があります。P1・P2・P8です。                     |
| N10・二種類のキュー             | 一部解消 | 表示と取消可能範囲を分けました。配信済みを識別する永続情報と、メモリー上の圧縮キューが再起動で失われた場合の扱いは不足しています。P9です。         |
| N11・ユーザー発言の全件読み取り | 解消     | 別取得する初回発言と、200件・20万字の取得上限、SQLでの本文切り詰めを明記しました。LOG側の取得量はP10です。                                         |
| N12・A9の境界                   | 解消     | `T ≤ S`の拒否と`T = S + 1`の通常巻き戻しを分け、A9・A10の期待結果を揃えました。                                                                    |
| R3・永続化と受付判定            | 一部解消 | 操作前の記録は改善しました。復旧・resendの遷移と、受付不明を解決するまでの受付制限が残ります。P1・P2です。                                         |
| R4・連続送信と遅延イベント      | 一部解消 | DB状態による拒否と世代照合を追加しました。拒否時に現在のセッションを変更する問題と、世代更新の漏れが残ります。P3・P6です。                         |
| R5・巻き戻し境界                | 一部解消 | 完了済み乗り換えの境界は明確です。セグメント作成前の乗り換えと、独立workerで動く巻き戻しの競合は防げません。P5です。                               |
| R6・cursor消去とイベント再生    | 一部解消 | 明示的nullとパケットの再生元は解消しました。新セッションのcursorまで消す読み方と、世代更新の経路が残ります。P6・P8です。                           |
| R7・ターン担当の確定            | 一部解消 | 記録イベントと過去分の不明表示は妥当です。pending行との関連付け、送信結果に対応するモデル値の固定が不足しています。P7です。                        |
| R8・追加ガードと対象制限        | 一部解消 | 削除済みinstanceでstopSessionを呼ばない例外経路を追加しました。ただし、許可リストは移行先だけの判定になっています。P12です。                       |
| R9・最終入力の予算              | 解消     | 展開後の入力、予算の下限0、エスケープ後の計数、内部フラグと最終検証を定義しました。                                                                |
| R10・指示と変更内容             | 解消     | 最新訂正を優先する順序と、チェックポイント差分の意味を揃えました。過去の文脈本文を渡さない制限も明示しています。                                   |
| R12・予約、キュー、失敗後の操作 | 一部解消 | 操作名と表示は揃いました。終了時の新セッション整理、未送信発言の扱い、圧縮キューの再起動時処理が残ります。P8・P9です。                             |
| R13・失敗経路の受入条件         | 一部解消 | 境界・受付後DB失敗などを追加しました。操作成功後から結果保存前の終了、直接圧縮、別端末での競合、担当記録の到着順を明示した条件が必要です。         |
| R14・読み取り量と配信量         | 一部解消 | USERの取得量と通常snapshotの本文除外は改善しました。LOG側の上限と、新規イベントの配信方法が不足しています。P10・P11です。                          |

## 新規指摘一覧

### P1・Blocker｜技術・目付｜4章・4.1・8.2・9.1

再開始とresendを、現在の遷移規則では表現できません

**確認済み**  
4.1は段階の後戻りを禁止する一方、9.1は`packet-built`から新しい`start-planned`・`started`を記録して復旧します。最新段階と、最新試行の進捗を分けていません。さらに、開始の繰り返しを許す条件は「`submit-planned`の前」ですが、8.2のresendはその後でもセッションの再開始を要求します。

CLI受付とDB保存が別であることも確認しました。[ProviderService.ts:1771](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1771)、[OrchestrationEngine.ts:274](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts:274)。

**影響・予測**  
受付不明のまま再起動し、「もう一度送る」を選んでも、必要な開始イベントをdeciderが拒否します。復旧途中の終了でも、どの試行の開始結果が保存済みか判定できません。

**処方**  
操作全体の到達段階と、試行ごとの開始・送信状態を分けてください。resend承認後の再開始を明示的に許し、保存済みパケットを維持する遷移表を一つに揃えます。

### P2・Blocker｜技術・目付｜4章・4.1・7.3・9.1・9.3

判断待ちの失敗を「終了」とすると、次の送信を断れません

**確認済み**  
4章は`failed-retryable`と`unknown-delivery`を「終わり方」に分類しています。9.3の進行中判定は「deliveredにも終わり方にも至っていない操作」なので、この二つを除外します。しかし8.2では、同じ操作をretry・resolveで続けます。

起動時の既存継続処理は、状態とcursorなどで送信を判断します。[serverRuntimeStartup.ts:646](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/serverRuntimeStartup.ts:646)。

**影響・予測**  
別端末から新規送信や別の乗り換えが進んだ後に、古い操作をretryできてしまいます。受付不明のスレッドが起動復旧の除外対象から外れる可能性もあります。

**処方**  
「判断待ち」と「閉じた」を区別してください。retryable・unknownは未解決の同じ操作として保持し、新規送信・別操作・既存自動継続を拒否します。retry・resolveを受け付ける際も、現在の操作IDと試行を照合する必要があります。

### P3・Blocker｜技術・金継ぎ｜9.3

次の送信を断るために、現在のターンをerrorへ変更します

**確認済み**  
9.3で指定する`handleTurnStartFailure`は、失敗activityだけを追加する処理ではありません。現在のスレッドセッションをerrorにし、`activeTurnId`をnullへ変更します。[ProviderCommandReactor.ts:1267](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1267)、同`:419`・`:428`。

SQL projectorはerrorのsessionイベントでpending行を削除し、runningターンも終了扱いにします。[ProjectionPipeline.ts:1445](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1445)。

**影響・予測**  
最初の送信を進めている最中に、別端末からの二回目の送信を断るだけで、最初のターンの状態・担当関連付け・表示を損ないます。

**処方**  
拒否したmessageIdにだけ未送信の失敗を記録する処理を使ってください。進行中のセッション、activeTurnId、先行要求のpending情報は変更しない仕様にします。

### P4・Blocker｜技術・目付｜1.3・4.2・7.2・7.3・9.3

圧縮経路では「worker内でsubmit-plannedまで進む」が成立しません

**確認済み**  
通常送信は要求組み立て後にforkします。しかし`/compact`の経路は、`ensureSessionForThread`、圧縮、復元、キュー再要求をまとめてforkしています。[ProviderCommandReactor.ts:1447](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1447)、同`:1479`・`:1493`・`:1524`。

再要求のdispatchとDeferred待ちは、このfork側です。同`:349`・`:369`。worker側の早期終了にもDeferredを完了する処理があります。同`:1868`。したがって、**現行のDeferred待ちがworkerを止めるデッドロックは確認していません**。

**影響・条件付き**  
新担当を選んで`/compact`を送ると、共通ensureで乗り換えを開始し、その後は通常送信のパケット作成・submitへ到達しない経路になります。`started`で操作が残り、後続要求も拒否され得ます。fork側の準備と次のworker処理も並行します。

**処方**  
圧縮コマンドで乗り換えを開始するかを明記してください。通常送信、圧縮、起動復旧、retryでDBの受付条件を共通化し、workerの直列性だけに依存しないようにします。

### P5・Blocker｜技術・目付｜5.2・7.4・9.3

セグメント確定前の巻き戻しを防げません

**確認済み**  
セグメント行は`delivered`で作られます。7.4は行がなければ従来どおり処理します。乗り換え中の巻き戻しを拒否する規則はありません。

両revertコマンドは同じイベントになり、独立したCheckpointReactorのworkerが処理します。[decider.ts:1820](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:1820)、[CheckpointReactor.ts:1023](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/CheckpointReactor.ts:1023)。ファイル復元はnative rollbackより先です。同`:849`・`:871`。

**影響・予測**  
初回乗り換えが`started`の時点で別端末から巻き戻すと、セグメントなしとして通り、新セッションに対して旧履歴のターン数でrollbackします。失敗しても、ファイルだけ戻った状態になり得ます。

**処方**  
`requested`で境界Sを固定し、未解決の乗り換え中は両revertを拒否してください。乗り換えと巻き戻しの受付を同じDB状態で順序付け、受理済みの巻き戻し中も新しい乗り換えを開始しないようにします。処理側の判定は`:808`より前で妥当です。

### P6・Major｜技術｜3章・4章・7.5

生成時の世代付与は可能ですが、世代を更新する経路が漏れています

**確認済み**  
Claudeは`context`を持つ箇所で開始・送信・終了イベントを生成しています。[ClaudeAdapter.ts:5027](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:5027)、同`:5064`・`:5230`・`:4349`。共通の`offerRuntimeEvent`は現在contextを受け取りません。同`:2132`。

Codexはセッションごとのfiberで変換し、共通baseと追加エラーを作ってキューへ入れます。[CodexAdapter.ts:2369](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/CodexAdapter.ts:2369)、同`:986`・`:2437`・`:2460`・`:2517`。`input.sessionGeneration`をclosureで固定して付与できます。

ただし、Claudeの通常rollbackはアダプター内部でstartSessionを呼び直します。同`:5488`。Codexのmanaged runtime変更も内部再開始です。同`:2604`。recoverもProviderService.startSessionを通らず直接adapterを呼びます。[ProviderService.ts:1299](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1299)。

**影響・予測**  
内部再開始で旧世代を再利用するか、世代なしのイベントを生成します。前者は旧イベントを見分けられず、後者は乗り換え済みスレッドで全イベントを捨てます。開始イベントはbinding保存より先に出るため、比較対象の更新順も必要です。

**処方**  
世代の割当て元を一つにし、`start-planned`の予約値、直接recover、内部再開始まで統一してください。adapter開始前に比較対象を保存し、Claudeはcontextを受け取る生成関数、Codexは全生成結果への付与で漏れを防ぎます。

### P7・Major｜技術・金継ぎ｜5.4

二つのIDを持つだけではpending行と同じ行に書けません

**確認済み**  
pending行は要求ごとに置き換わります。[ProjectionTurns.ts:267](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionTurns.ts:267)。sessionイベントでは、現在のpendingからturnId付きの行を作り、その後pending行を削除します。[ProjectionPipeline.ts:1514](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1514)、同`:1550`・`:1578`。

また、sendTurnの戻り値はmodel・generationを持ちません。[provider.ts:87](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/provider.ts:87)。通常送信は並行してforkされ、アダプターは送信中にsession.modelを変更できます。

**影響・予測**  
Aの受付前にBの要求が保存されると、AのturnIdがBのpendingMessageIdと結び付きます。担当イベントで3列だけ更新しても、誤った関連付けが残ります。戻り後に稼働セッションを読み直す方法では、別送信のモデルを記録する可能性もあります。

**処方**  
担当イベントからturnIdの行を確保し、messageIdとの対応を明示的に修復してください。pendingに先に書くなら、移行時の担当列コピーと対象messageIdの照合が必要です。モデル・世代は、その送信の受付結果に対応する値として固定します。

### P8・Major｜技術・目付｜3.1・5.3・8.2

abort後の白紙セッションと、新cursorの扱いが未定義です

**確認済み**  
パケット作成は新セッション開始後です。必須部分が入らず失敗しても、新セッションは残ります。8.2のabortは操作を閉じるだけですが、3.1は稼働セッションがあればnativeと判定します。

5.3の「乗り換えの経路でbindingを書くときはcursorをnull」にも適用範囲の限定がありません。現行は新セッション開始後と送信受付後にもcursorを保存します。[ProviderService.ts:1555](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1555)、同`:1795`。

**影響・予測**  
「やめる」の次の送信が、引き継ぎのない白紙の新担当へ届きます。5.3を全binding更新に適用すると、新担当の再開cursorまで失い、成功直後の再起動でもnative resumeできません。

**処方**  
未引き継ぎセッションをnative継続の対象から外し、abort時の停止・binding整理を定義してください。cursorのnull化は旧担当の破棄に限定し、新担当から得たcursorは保存します。discard時も、実際に受け付けられたターンが残る場合の扱いを明記する必要があります。

### P9・Major｜技術・目付｜3.1・6.4・8.2

「配信済み」と境界番号の取得元がありません

**確認済み**  
ユーザー発言はCLI送信前に`thread.message-sent`として保存されます。[decider.ts:1443](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:1443)。メッセージ契約とprojectionには、CLIへの配信状態や発言のsequenceがありません。[orchestration.ts:574](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/orchestration.ts:574)、[ProjectionThreadMessages.ts:26](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Services/ProjectionThreadMessages.ts:26)。

圧縮キューはMapです。[ProviderCommandReactor.ts:257](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:257)。

**影響・予測**  
境界以前にも未送信・拒否・abort済み発言があるため、sequenceの上限だけでは除外できません。「届いたか不明・再送なし」の発言が、次のパケットでは有効な指示に戻る可能性があります。再起動後はMapから未送信判定もできません。

**処方**  
発言ごとの送信状態と安定した順序の取得元を定義してください。境界と配信状態の両方で選別し、受付不明は状態付きで扱います。圧縮キューの再起動時には、失われた発言を未送信として明示するか、永続要求から復元する仕様が必要です。

### P10・Major｜軍配・技術｜6.4・9.3

LOGの50ターン制限では読み取り量を制限できません

**確認済み**  
新専用クエリはUSERに件数・字数上限を設けていますが、assistant本文とtool summaryは50ターンの範囲だけです。1ターン内のactivity件数とsummaryの字数は制限されていません。[orchestration.ts:661](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/contracts/src/orchestration.ts:661)。

既存の詳細activity取得には500件上限がありますが、新専用クエリに引き継ぐとは書かれていません。[ProjectionSnapshotQuery.ts:1499](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1499)。

**影響・条件付き**  
一つの長いターンに多数のツール記録があると、6万字の出力を作るために大量の本文を読みます。9.3どおりglobal worker内で行えば、他スレッドの停止・承認応答も待たされます。

**処方**  
LOGにも取得件数・本文ごとの字数・合計字数の上限を設け、SQLで切り詰めてください。必須のSTATEやPLANは、LOGの取得上限とは別に必要分だけ取得します。

### P11・Major｜技術・金継ぎ｜5.2・5.4・6.7・8.6

新しい状態の配信と、パケット本文の除外を定義する必要があります

**確認済み**  
現在のthread詳細配信はイベント種別の許可リストを使っています。新しい乗り換え・担当記録イベントは対象外です。[ws.ts:346](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/ws.ts:346)。詳細配信ではactivity以外のpayloadをそのまま返します。[ActivityPayloadProjection.ts:691](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/ActivityPayloadProjection.ts:691)、[ws.ts:2196](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/ws.ts:2196)。

**影響・条件付き**  
現在の配信対象のままでは、開いている画面へ新しい担当記録が届きません。新イベントをそのまま許可すると、packet-builtの全文まで通常配信され、「全文は見るときだけ取得」と食い違います。旧クライアントへの未知イベント配信にも互換処理が必要です。

**処方**  
snapshot・live・再接続時のreplayで配信する状態を揃えてください。本文を除いた通知を定義し、全文は専用RPCに限定します。旧クライアントへ未知イベントを送らず、判断待ちの状態と案内文を既存の対応可能な形式で伝える必要があります。

### P12・Minor｜軍配｜3.1・7.1・8.1

許可リストが移行先だけを制限しています

**確認済み**  
3.1の拒否条件は「移行先が許可リストにないとき」です。この条件だけでは、CursorなどからCodexへの乗り換えも許可します。現行の比較箇所は両driverを扱っています。[ProviderCommandReactor.ts:688](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:688)。

**影響・予測**  
Phase 1をClaude↔Codexに限定する裁定と、実装する判定条件が一致しません。

**処方**  
乗り換え元・移行先の両方が許可対象であることを条件にしてください。旧instance削除時は、保存済みbindingのdriverで判定します。

## 誤っていたfile:line引用

**別のコードを指す数値引用は見つかりませんでした。** 第3版で追加・訂正された引用も実コードで照合しました。

| 引用                                                                   | 照合結果                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GitVcsDriver.ts:1025`、`CheckpointReactor.ts:699`                     | 親指定のないcommit-tree、基準ref生成と一致します。ただし`:699`は常に番号0ではなく、現在の最大番号を使い、初回に0になります。         |
| `ProviderCommandReactor.ts:1889`、`DrainableWorker.ts:47`              | 単一workerによる直列処理と一致します。fork側まで直列である根拠にはなりません。                                                       |
| `ProviderCommandReactor.ts:257 / :343 / :369 / :1524`                  | 圧縮キュー、再要求、Deferred待ち、通常送信forkと一致します。圧縮全体のforkは`:1479`です。                                            |
| `providerRuntime.ts:47 / :202`、`ClaudeAdapter.ts:4349`                | 世代なしの共通契約と終了イベント生成に一致します。空のproviderRefsの行そのものは`:4359`です。                                        |
| `ProviderService.ts:1232 / :1129 / :1664`、`CheckpointReactor.ts:1040` | 購読、配信前のbinding更新経路、画像付随情報、独立購読と一致します。                                                                  |
| `ProjectionPipeline.ts:1388 / :1445 / :1550 / :1953 / :2085`           | pending生成、turn関連付け、projector登録・適用入口と一致します。「到着順にかかわらず同じ行に書ける」という説明はP7の修正が必要です。 |
| `ClaudeAdapter.ts:5151`                                                | steeringで同じturnIdを使う説明と一致します。                                                                                         |
| `MessagesTimeline.tsx:2437 / :2455`                                    | メタ行の実体と表示関数に一致します。前巡の引用位置は訂正済みです。                                                                   |
| `serverRuntimeStartup.ts:646`、`CheckpointReactor.ts:808`              | 自動継続条件とrollback capability判定に一致します。                                                                                  |

コードの置き場所の説明としては、6.5にも補足が必要です。コンポーザー文脈の展開はProviderService内ではなく、現在は`ProviderCommandReactor.ts:1495`にあります。`expandTurnInputText`へ移す際は、この呼び出しも置き換える必要があります。

## 見送った項目と理由

- **裁定済みの5方針**  
  Claude↔Codex限定、`T ≤ S`禁止、ロック不使用、必須パケット不足時の中止、受付不明・再送なしの記録は維持します。指摘は実装条件の整合に限定しました。
- **展開関数の抽出と内部フラグ**  
  実現可能です。文脈、引用、添付パス、captured-window情報を一度展開し、ネイティブ添付と最終検証を残す境界は明確になりました。
- **巻き戻しの共通判定位置**  
  両revertは同じCheckpointReactor入口へ到達します。`:808`より前の共通判定で、ファイルを戻さず拒否できます。問題はP5の受付競合です。
- **受付済みと実行完了の同一視**  
  turnId返却を受付の区切りにする方針は妥当です。実際の作業完了や完全な配信保証まで求めません。
- **画面計測、CLI長文受付、障害の実再現**  
  ブラウザ、アプリ、ビルド、テストは実行していません。表示・負荷・競合の影響は静的な予測として記載しました。
- **Phase 2以降の機能**  
  他provider、要約、並行実行、境界を越える巻き戻しの設計拡張は今回の対象外です。

## 結パパへの判の問い

裁定済みの方針を再判断する必要はありません。追加で決める点は次の二つです。

1. `failed-retryable`で「やめる」を選んだ発言は、「未送信・取消」として残し、次回の引き継ぎ指示から除外する扱いでよいですか。
2. `/compact`は現在の担当でのみ実行し、モデルの乗り換えは次の通常発言で開始する扱いでよいですか。

**実装に入ってよい水準には達していません。Blockerが5件残っています。**
