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

---

## コードレビュー: イベントと decider の層（2026-10-06）

対象: packages/contracts/src/providerSwitch.ts、orchestration.ts、apps/server/src/orchestration/providerSwitchState.ts、decider.ts、projector.ts、Layers/CheckpointReactor.ts、decider.providerSwitch.test.ts

経過: 第1巡 Red（Major6・Minor2）→ 第2巡 Red（Major5・Minor1）→ 第3巡 Red（Major1）→ 第4巡 Green

### 第1巡（Codex 原文）

判定は **Red** です。再送許可、冪等性、巻き戻しとの排他に修正が必要です。コードは変更していません。

Blockerはありません。Majorは6件、Minorは2件です。

1. **Major — failed後に、許可なしで再送できる**  
   [providerSwitchState.ts:221](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:221)  
   `submit(2): failed → submit(3): planned`が、`resolve(resend)`なしで通ります。§4.3の「2回目以降はresolve(resend)が必要」に反します。  
   **修正案:** 既存のsubmitがあれば`resendAllowed`を必須にする。同時に、failedからも`unknown-delivery → resolve`へ進めるようにする。[現テスト:444](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.providerSwitch.test.ts:444)も、無許可の再送を拒否するテストへ変更してください。

2. **Major — 解決済みのswitchIdを再び開ける**  
   [providerSwitchState.ts:58](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:58)、[同:290](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:290)  
   delivered後に同じrequestを再記録すると、`pending`が`requested`に戻ります。abort/discard後も同じです。同じcommandIdはエンジンが重複排除しますが、別commandIdによる同一操作の再記録では再開してしまいます。  
   **修正案:** 終了済みswitchIdを保持・照合し、重複requestで操作を開き直さないようにする。delivered・abort・discard後の再記録をテストしてください。

3. **Major — 古いplannedの再適用で最新試行が後退する**  
   [providerSwitchState.ts:340](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:340)  
   `start(3): succeeded`へ以前の`start(1): planned`を再適用すると、`latestStart`が1のplannedへ戻りました。`lastGeneration`だけは新しい値のままです。また、[同:179](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:179)では、最新試行を更新した後の過去の同一succeeded記録を拒否します。§4.4の冪等性を満たしません。  
   **修正案:** 古いplannedで最新試行を上書きしない。過去の試行についても、同一記録の重複を照合できる情報を保持してください。

4. **Major — 同じIDの異なる内容を重複として受け付ける**  
   [providerSwitchState.ts:182](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:182)、[同:153](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:153)  
   同じsubmitのsucceeded記録で`turnId`を変えても成功します。packetも、packetIdが同じなら異なる本文・統計を拒否しません。純粋projectorでは元の値が残る一方、イベントストアには矛盾する記録が入ります。  
   **修正案:** requestの固定項目、試行のgeneration・turnId、packetの本文ハッシュ・統計を照合し、内容が一致する記録だけを冪等として扱ってください。

5. **Major — 受付不明だった発言をcancelledに変更できる**  
   [providerSwitchState.ts:237](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:237)、[decider.ts:2279](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:2279)  
   `submit.planned → unknown-delivery → resolve(resend) → 新start.failed → failed-retryable → abort`で、発言がcancelledになります。最初の送信が届いていた可能性は残っています。  
   **修正案:** `abandoned`を未送信と扱わず、送信結果が不明という履歴を保持する。その履歴がある操作を閉じるときは、`unknown-discarded`となる判断経路を残してください。

6. **Major — 重複した失敗記録で巻き戻しの排他が解除される**  
   [projector.ts:1143](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/projector.ts:1143)  
   巻き戻しを2件受け付けた後、同じIDの失敗activityを2回反映すると、activityは1件なのに`revertsInFlight`が0になります。その結果、別の巻き戻しが未完了でもrequestを受け付けました。  
   **修正案:** 失敗・完了を巻き戻し要求のIDと対応づけ、同じ要求を一度だけ減算する。[requestedの加算:1165](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/projector.ts:1165)と[revertedの減算:1110](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/projector.ts:1110)も、重複適用をテストしてください。

7. **Minor — plannedのstartからの自動復旧手順が未検証**  
   [providerSwitchState.ts:202](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:202)、[テスト:468](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.providerSwitch.test.ts:468)  
   plannedのstartを残して再起動した場合、§9.1どおり新startを直接記録すると拒否されます。旧startをfailedとして確定してから新startへ進む経路は使えるため、復旧不能ではありません。  
   **修正案:** この前処理を復旧手順として明記し、old-stopped・packet-built・resend後の再起動をテストしてください。現在のテストは、awaiting-userを経由する復旧だけです。

8. **Minor — asキャストでtypeとpayloadの対応を検査できない**  
   [decider.ts:2273](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:2273)、[同:2327](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:2327)  
   現在の対応に不一致は見つかりませんでした。ただし、対応表のイベント名を誤って変更しても、キャストで型検査を通せます。  
   **修正案:** 型を絞った分岐か型付きイベント生成関数を使う。10種類すべての出力を`OrchestrationEvent`でdecodeするテストも追加してください。

互換性について、新スキーマによる旧スナップショットのdecodeと、旧スキーマによる新任意項目付きスナップショットのdecodeは確認できました。旧イベントスキーマでは新イベントをdecodeできません。現在は未dispatchですが、配信開始前に旧クライアントへの対応が必要です。

contractsとserverの型チェックは成功しました。新規34件と既存projectorテストは、一時ディレクトリ作成のEPERMで収集前に停止しました。lintも一時ファイルを作れず停止しています。上記の不具合は、純粋関数・decider・projectorをメモリ上で直接実行して再現しました。SQL projectionと起動時の読み戻しの未実装は、今回の指摘に含めていません。

**次の層（SQL projectionと読み戻し）には、現状では進めません。** Major6件を修正し、再現経路の回帰テストを追加してから進むのが妥当です。

### 第2巡（Codex 原文）

判定は **Red** です。Blockerなし、Major5件、Minor1件。

前回のMajor1・3・5とMinor1は解消しました。Major2・4・6とMinor2は一部解消です。

1. **Major — 古い待機イベントが、新しい送信試行をabandonedにする**  
   [providerSwitchState.ts:485](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:485)  
   `submit(2) → awaiting-user → resolve(resend) → submit(3).planned`の後、最初のawaiting-userイベントを再適用すると、操作がawaiting-userへ戻り、試行3もabandonedになります。その後の試行3の結果は拒否されました。  
   **直し方:** 待機イベントに対象attemptIdまたはwaitIdを持たせ、処理済みの待機記録が新しい試行に作用しないようにする。[現在のテスト:824](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.providerSwitch.test.ts:824)はイベント列全体を再適用するため、最後のresolveで状態が戻り、この途中の不整合を検出できません。古い待機イベントだけの再適用を追加してください。

2. **Major — 50件の履歴から外れた解決済み操作を再開できる**  
   [providerSwitchState.ts:369](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:369)、[同:95](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:95)  
   switch-1をdeliveredにした後、別IDのrequest・abortを50回行うと、switch-1のrequestを再び受け付けます。lastDeliveredにswitch-1が残っていても防げません。  
   **直し方:** 50件はキャッシュに限定し、履歴から外れたIDも終了済みと照合できる仕組みを設ける。純粋状態での保持、または永続記録による受付前の検証が必要です。履歴が入れ替わる境界をテストしてください。

3. **Major — 本文だけ異なるpacketを、同じ記録として受け付ける**  
   [providerSwitchState.ts:217](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:217)  
   本文を同じ長さの別文字列にし、sha256と他の項目を据え置くと通ります。本文とsha256の対応を検証していないためです。異なる本文のイベントを保存でき、projectorには最初の指紋が残ります。  
   **直し方:** 本文から実際のSHA-256を計算し、payloadの値と照合する。テストの固定値`"sha"`も実際のハッシュへ変更し、「同じ長さの別本文・同じ申告ハッシュ」を拒否する例を追加してください。

4. **Major — 巻き戻し完了後の重複と、旧形式の重複が残る**  
   [projector.ts:254](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/projector.ts:254)、[同:270](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/projector.ts:270)  
   次の2経路を再現しました。

   - 要求Aの完了後に要求Aのイベントを再適用すると、Aが再び進行中になり、乗り換えを拒否する。
   - 巻き戻し2件の進行中に、要求IDのない同一activity IDの失敗記録を2回適用すると、2件とも解除する。

   **直し方:** 完了済み要求の再追加を防ぎ、旧形式の終了記録も一度だけ処理する。[現在のテスト:942](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.providerSwitch.test.ts:942)には「完了後の要求再適用」と「旧失敗記録の重複」を追加してください。

5. **Major — 受け付けたfailed-retryableから、retryで再送に進めない**  
   [providerSwitchState.ts:326](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:326)、[同:305](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:305)  
   `submit.failed → await-user(failed-retryable) → retry`はすべて通ります。しかし次のsubmitは、resendAllowedがfalseのため拒否されます。無許可再送の拒否は正しくなりましたが、受け付ける復旧状態と操作が一致していません。  
   **直し方:** 再送許可を消費した後の送信失敗はunknown-deliveryへ分類し、failed-retryableを拒否する。resolve(resend)の許可が残っている間の開始失敗は、retryで進める区別を維持してください。

6. **Minor — キャストを外しても、typeとpayloadの型の対応が失われている**  
   [decider.ts:178](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:178)  
   `Omit<OrchestrationEvent, "sequence">`はunionを分配しません。メモリ上の型検査では、requestのpayloadをresolvedのtypeに組み合わせても、この型では通りました。  
   **直し方:** unionの各variantへOmitを分配する型を使う。全10種のdecodeテスト追加は有効ですが、コンパイル時にも対応を検査できるようにしてください。

contractsとserverの型チェックは成功しました。新規51件のテスト本体も、メモリ上のassertハーネスで通過しています。これはVitestの実行結果とは別の確認です。正式ランナーの141件、lint、環境依存8件の変更前との比較は、この巡では再実行していません。ファイルは変更していません。

**次の層（SQL projectionと読み戻し）には、現状では進めません。** Major5件の修正と、上記の境界を確認する回帰テストが必要です。

### 第3巡（Codex 原文）

判定：**Red**。Blocker 0件／Major 1件／Minor 0件。コード・ファイルは変更していません。

**Major：再開直後には、古い待機コマンドがまだ通ります。**  
[providerSwitchState.ts:321](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:321)、[同ファイル:495](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:495)

retry／resolve(resend)ではattemptIdが変わらないため、次の試行を記録するまで古いawait-userを受け付けます。別commandIdで送る以下の経路を再現しました。

```text
submit(2) → await-user(unknown-delivery, 2) → resolve(resend)
→ 古いawait-user(unknown-delivery, 2)
→ awaiting-userに戻り、submit(3)が拒否される
```

試行がない場合も、`await-user(failed-retryable, 0) → retry → 古いawait-user(0)`で同じ後退が発生。ユーザーは再開を選び直す必要があります。

**直し方：** retry／resolve(resend)ごとに増える番号を状態に保持し、await-userにも処理開始時の番号を持たせて照合してください。deciderは不一致を拒否し、projectorは無視します。[現在のテスト:1073](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.providerSwitch.test.ts:1073)はsubmit(3)の記録後を確認しています。その手前の区間とattemptId=0の経路を追加する必要があります。

前巡への対応は、1が一部解消、2・3・5・6が解消。4の旧形式失敗の重複対策も確認しました。「完了後に古いrequestedを再適用する」経路は確認できず、その指摘は取り下げます。

ただし、**projectEventが必ず一度だけ呼ばれるという前提には例外があります。** [OrchestrationEngine.ts:322](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts:322)でコミット済みモデルへ更新した後に異常終了すると、[失敗時の復旧処理:119](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts:119)が同じ保存済みイベントを現在のモデルへ再適用します。SQLの適用済みsequence管理では防げません。ただし単一workerで処理するため、この経路から「巻き戻し完了後に古いrequestedが戻る」とは判断できません。

検証では、新規56件のテスト本体をメモリ上の検証用ハーネスで実行し、全件成功。contracts／serverの型チェックもエラー0でした。Vitest・lintは読み取り専用環境の制限で再実行できていません。

**次の層（SQL projectionと読み戻し）に進んでよいか：現時点では不可です。** 上記Majorを修正し、再開直後の2経路を確認してから進めてください。

### 第4巡（Codex 原文）

判定：**Green**。コード・ファイルは変更していません。

- **Blocker：なし**
- **Major：なし**。前巡の1件は解消しています。
- **Minor：なし**

[providerSwitchState.ts:325](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:325)の照合により、retry／resolve(resend)直後の古い待機も拒否できています。[projector側の反映処理:498](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:498)でも無視され、その後のsubmit(3)とresumeCount=1の新しい待機は受け付けられました。

resumeCountはawaiting-userから再開するときだけ増加します。連続二重適用でも追加で増えず、再開回数を含む17イベントの各途中状態が一致することを確認しました。

検証：新規59件のテスト本体をメモリ上のハーネスで実行し、全件成功。contracts／serverの型チェックもエラー0でした。Vitestによる関連149件とlintは、読み取り専用環境では再実行していません。

**次の層（SQL projectionと読み戻し）に進んでよいか：はい。** Phase 0の対象範囲では進行を妨げる指摘はありません。次の層ではresumeCountも永続化・読み戻しの対象に含めてください。

---

## コードレビュー: SQL projection と起動時の読み戻し（2026-10-06）

対象: persistence/Migrations/055、Services|Layers/ProjectionThreadProviderSwitches.ts、ProjectionThreadMessages（delivery_state）、Layers/ProjectionPipeline.ts、Layers/ProjectionSnapshotQuery.ts、テスト

経過: 第1巡 Red（Major2・Minor2）→ 第2巡 Green

### 第1巡（Codex 原文）

判定：**Red**。Blocker 0件／Major 2件／Minor 2件。コード・ファイルは変更していません。

**Major 1：巻き戻しで、残したメッセージの送信状態が消えます。**  
[ProjectionPipeline.ts:1236](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1236)

`thread.reverted`は全メッセージを削除し、残す行を再挿入します。既存のメッセージリポジトリがdelivery_stateをSELECT・INSERTしないため、残した行もNULLへ戻ります。cancelledのユーザーメッセージを残す巻き戻しで、**cancelled → NULL（delivered）**を再現しました。

直し方：不要な行だけ削除するか、内部リポジトリの型・SELECT・再挿入にdelivery_stateを含めてください。公開読み出しを次の層へ送る場合でも、この保持処理は今回必要です。送信状態を付けた行が、巻き戻しとbootstrap後も保持されるテストを追加してください。

**Major 2：packetIdの衝突を無視すると、状態と本文が食い違います。**  
[ProjectionThreadProviderSwitches.ts:78](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:78)、[ProjectionPipeline.ts:1980](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1980)

別の操作が同じpacketIdを使うと、`INSERT OR IGNORE`は以前の行を残したまま成功し、その後のfoldは新しいハッシュを状態へ保存します。2スレッドで同じIDに本文`packet-a`／`packet-b`を指定すると、両方のdispatchが成功。後の状態は`packet-b`のハッシュですが、保存された本文は`packet-a`でした。

直し方：衝突時に所有threadId・switchId、本文・ハッシュ・統計を照合し、同一内容だけ無視してください。不一致ならエラーにして、イベントと状態のコミットも取り消します。同一内容の再記録と、別内容・別操作の衝突をテストしてください。現在の「never rewrites」テストはSELECTだけで、再挿入を確認していません。

**Minor 1：migrationの時刻が、最終イベントの時刻ではありません。**  
[055_ProjectionThreadProviderSwitches.ts:57](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Migrations/055_ProjectionThreadProviderSwitches.ts:57)

`MAX(occurred_at)`は最大sequenceとは別の行を選べます。最終sequence=3の時刻が9月1日でも、カーソルには先行イベントの10月2日が入りました。この値もスナップショットのupdatedAt算出に含まれます。また、実行計画は`SCAN orchestration_events`でした。

直し方：`ORDER BY sequence DESC LIMIT 1`でsequenceとoccurred_atを同じ最終行から取得し、空DBでは0とepochを補ってください。時刻が逆順になる既存DBと空DBのテストを追加します。

**Minor 2：乗り換え後のthread.updatedAtが、読み戻しで古い値へ戻ります。**  
[ProjectionPipeline.ts:1995](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1995)

純粋projectorは乗り換えイベントでthread.updatedAtも更新しますが、SQLでは乗り換え状態行だけを更新しています。10時のスレッドに11時のrequestを送ると、純粋projectorでは11時、getCommandReadModelでは10時でした。

直し方：threads projectorでも対象イベントのupdatedAtを反映してください。既存テストは全コマンドで同じcreatedAtを使うため、時刻を分けて比較する必要があります。

resumeCount・resendAllowed・lastDeliveredの読み戻し、thread.createdの削除処理、カーソルを戻した後のbootstrapでは乗り換え状態が一致しました。新規7件のテスト本体は、ディレクトリ作成・ファイル操作をスタブにしたメモリ上のSQLiteハーネスで全件成功。serverの型チェックもエラー0でした。Vitestそのものは未実行です。

**次の層に進んでよいか：現時点では不可です。** Major 2件を修正し、保存内容と再構築結果を再確認してから進めてください。

### 第2巡（Codex 原文）

判定：**Green**。コード・ファイルは変更していません。

- **Blocker：なし**
- **Major：なし**
- **Minor：なし**

前巡のMajor 2件・Minor 2件はいずれも解消しています。

- 巻き戻し・bootstrap後もdelivery_stateを保持。状態なしのupsertでも消えません。
- packetId衝突時はdispatchが失敗し、イベント数・保存済み本文・状態・読み戻しは変化しません。
- migrationは最終sequenceと時刻を同じ行から取得。時刻が逆順のDB・空DBでも正しく初期化されます。
- 乗り換えイベント後のthread.updatedAtも、純粋projectorと一致しました。

新規11件と既存メッセージリポジトリ6件のテスト本体を、ファイル操作をスタブにしたメモリ上のSQLiteハーネスで実行し、全17件成功。実際の巻き戻しとカーソルを戻した後のbootstrapも別途確認しました。serverの型チェックはエラー0です。Vitestの783件とlintは再実行していません。

**次の層に進んでよいか：はい。** 今回のSQL projectionと起動時の読み戻しの範囲では、進行を妨げる指摘はありません。

---

## コードレビュー: Phase 0 の残り（担当記録・展開の切り出し・設定・材料の取得、2026-10-06）

経過: 第1巡 Yellow（Major3・Minor1）→ 第2巡 Green（Minor1: 担当記録の message_id 索引。056 に追加済み）

### 第1巡（Codex 原文）

判定：**Yellow**。Blocker 0件、Major 3件、Minor 1件。コードは変更していません。

Blocker：なし。

Major（3件）

1. **上限を適用する前に、候補全件の本文・文脈を処理する**  
   [ProjectionThreadProviderSwitches.ts:304](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:304)、[同:387](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:387)  
   実際のSQLでは、ユーザー発言1,000件から33件を返す場合でも、1,000件すべての文脈JSONを解析します。LOGも、1ターン1,000件のツール記録から50件を返す際に、全1,000件のsummaryを処理します。返却量は制限されますが、本文処理と一時領域は履歴量に応じて増え、§6.4・P10の意図を満たしません。  
   **直し方：** 本文を含まないID・時刻で最新200件の候補を先に確定し、その候補だけで本文の切り詰め・文脈抽出・累積字数を計算してください。LOGも同様です。COUNTは別に残し、1ターン1,000件のケースを追加してください。

2. **SQLとJSの文字数の単位が異なり、省略字数が誤る**  
   [handoffSource.ts:17](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/handoffSource.ts:17)、[CrossProviderHandoff.ts:127](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/CrossProviderHandoff.ts:127)  
   SQLの`length/substr`はコードポイント数、JSの`length/slice`はUTF-16単位です。絵文字8,000個をSQLで6,000個に切ると、`fullChars=8000`、`text.length=12000`となり、SQLで省いた分が0になります。その後packet側で3,000個に切った結果は「6000字省略」で、実際に省いた5,000個ともUTF-16の10,000単位とも一致しません。PLAN・LOGも同じ問題があります。  
   **直し方：** 省略表示はコードポイント数に統一し、SQLで省いた分と`clip`で追加して省いた分を同じ単位で加算してください。packetの予算・provider上限は既存のUTF-16計算を維持します。絵文字を含むUSER・PLAN・LOGのテストが必要です。

3. **担当記録の対応を材料取得で使わず、ユーザー発言に別ターンの番号を付ける**  
   [ProjectionThreadProviderSwitches.ts:254](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:254)  
   ターン番号を担当記録の`messageId→turnId`対応から取得せず、従来の`pending_message_id`に依存しています。A要求→B要求→A受付・担当記録→B受付・担当記録をエンジン経由で再現すると、担当表は正しくても、パケットではAが「ターン不明」、BがAの「ターン1」になります。別テーブル化だけでは、P7の対応修復が材料取得に反映されません。  
   **直し方：** 担当記録の対応を優先してターン番号を取得し、既知の対応と矛盾するpendingは使わないでください。または担当イベントで既存の対応も修復します。A/Bの到着順テストで、担当値とパケットのターン番号まで確認してください。

Minor（1件）

- [cross-provider-handoff.md:552](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/docs/internals/cross-provider-handoff.md:552)  
  §16に変更説明がありますが、§5.4の列追加、§6.4のイベント順序番号、§6.5の単一関数、§15 P7の行修復は旧仕様のままです。該当箇所を現在の設計へ書き換え、§16には変更理由を残してください。

確認として、server/contractsの型チェックは成功しました。SQL統合テスト16件と新規の純粋関数・設定テスト9件の本体は、独自インメモリハーネスで通過しています。Vitestでの実行結果ではありません。送信テキストは、引用・添付・captured-window・上限付近を含む旧新224組合せで差分なしでした。

**Phase 0を完了としてPhase 1に進んでよいか：まだ不可。Major 3件の修正と回帰テストを先に完了してください。**

### 第2巡（Codex 原文）

判定：**Green**。前回のMajor 3件・Minor 1件はすべて解消しています。コードは変更していません。

Blocker：なし。  
Major：なし。

Minor（新規1件）

- [ProjectionThreadProviderSwitches.ts:266](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:266)  
  担当記録を`(thread_id, message_id)`で検索しますが、056の索引は主キー`(thread_id, turn_id)`だけです。実際のクエリ計画でも`thread_id`だけで絞り、最大201発言について担当履歴を繰り返し検索します。  
  **直し方：** 056に`projection_turn_assignments(thread_id, message_id, turn_id)`の索引を追加してください。長いスレッドでの検索量を減らす改善で、Phase 1への進行は妨げません。

候補だけの本文・文脈処理、USER・PLAN・LOGの省略数、エンジン経由のA/B到着順、設計書の更新を確認しました。

server/contractsの型チェックは成功。独自インメモリハーネスでSQL統合19件、純粋関数・設定9件のテスト本体が通過しました。Vitestでの実行結果ではありません。送信テキストも旧新224組合せで一致しました。

**Phase 0を完了としてPhase 1に進んでよいか：進んでよいです。** 上記Minorは改善事項として残せます。

---

## コードレビュー: Phase 1 第1部分（送信の流れへの組み込み、2026-10-06）

経過: 第1巡 Yellow（Major8・Minor1）→ 第2巡 Yellow（Major3・Minor2）→ 第3巡 Yellow（Major4）→ 第4巡 Yellow（Major1・Minor1）→ 第5巡 Green

### 第1巡（Codex 原文）

判定：**Yellow**。Blocker 0件、Major 8件、Minor 1件です。コードは変更していません。

Blocker：なし。

Major

1. [ProviderCommandReactor.ts:1613](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1613) — request の記録前に次の送信が通ります。  
   `startSwitch`全体をforkしているため、checkpoint数の取得中はDBにpendingがありません。次の旧担当宛て送信はnative経路に進み、その後の乗り換えで旧セッションを停止できます。取得をDeferredで止め、次の送信が拒否されないことを再現しました。  
   **直し方：** requestのdispatch完了までworker内で待ち、その後の`continueSwitch`をforkしてください。request前の競合を回帰テストに追加します。

2. [providerSwitchFlow.ts:482](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:482) — 送信前の失敗が`in-progress`のまま残ります。  
   `readHandoffSource`、設定・状態の再取得、各段階のdispatchには失敗処理がなく、外側ではログを出すだけです。材料取得失敗で`old-stopped / in-progress`、到達点の記録失敗で`requested / in-progress`に残ることを再現しました。retry・abortの受付条件を満たしません。  
   **直し方：** request成立後の処理全体で失敗を受け、submitのplanned前なら`failed-retryable`、それ以降なら`unknown-delivery`を記録してください。各段階で一度だけ失敗させるテストが必要です。

3. [providerSwitchFlow.ts:577](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:577)、[同:599](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:599) — 完了の記録が途中で確定します。  
   `delivered`でpendingを消してから、担当記録と発言の送信状態を別々にdispatchしています。後者が失敗すると、操作は解決済みなのに担当記録などが欠けます。担当記録失敗で`lastDelivered`だけが残ることを再現しました。`awaitUser`はpendingがないと何もしないため、catch追加だけでは直りません。  
   **直し方：** delivered・担当記録・発言の送信状態を、1コマンドの同一コミットで確定してください。

4. [providerSwitchFlow.ts:620](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:620)、[ProviderCommandReactor.ts:1590](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1590) — 未送信・拒否済みの発言を配達済みとして扱います。  
   保存直後の発言をpendingにする処理がなく、`delivery_state`はNULLです。NULLはdelivered扱いなので、後続の未送信発言を引き継ぎ履歴に入れられます。また、`hasOtherUserMessages`は送信状態を絞らず、rejectedしかないスレッドでもtrueになります。実際のengineとSQLで確認しました。  
   **直し方：** フラグonの新規発言は保存時からpendingにし、通常経路でも受付成功時にdeliveredを記録してください。乗り換え用の会話有無はdeliveredと旧データのNULLだけで判定し、既存の初回発言判定とは分けます。

5. [ProviderCommandReactor.ts:630](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:630)、[ProviderService.ts:1892](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1892) — 停止に失敗した旧セッションのcursorを新担当へ渡せます。  
   `stopSession`の失敗後も旧セッションが`listSessions`に残る場合、handoff経路も既存セッション分岐に入ります。820行で旧`resumeCursor`を取得し、新しい`startSession`へ渡します。DBのcursorをnullにしても、この明示入力は消えません。  
   **直し方：** handoffでは旧セッションを再利用せず、旧cursorを明示入力・bindingのどちらからも渡さないようにしてください。停止失敗で旧セッションが残るケースを検証します。

6. [ProviderService.ts:1908](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1908) — runtimePayloadを置き換えず、旧担当の情報を残します。  
   `directory.upsert`はオブジェクトをマージします。`activeTurnId`だけの指定では旧モデル情報や自動継続マーカーが残ります。実リポジトリで`continueAfterServerUpdate`と`continueAfterServerUpdatePrepared`の残存を確認しました。§5.3と異なり、既存の起動処理でも旧ターンの継続判定に使われます。  
   **直し方：** runtimePayloadを丸ごと置き換える更新を用意し、cursorの消去と同時に保存してください。

7. [providerSwitchFlow.ts:202](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:202) — 再起動後の旧モデルを、変更後の選択値から取得します。  
   稼働中セッションがなければ、`currentModel`は`thread.modelSelection.model`になります。クライアントは送信前にこの値を移行先へ更新するため、旧Codexの`from.model`がClaudeのモデルになる経路があります。同一担当で`requiresNewThreadForModelChange = true`の場合も、`modelChanged`がfalseになってnativeと誤判定することを再現しました。  
   **直し方：** bindingに保存した実際のモデルを返し、稼働中セッションがなければそれを使って旧担当とモデル変更を判定してください。

8. [providerSwitchFlow.ts:342](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:342) — 通常送信の担当を、受付後の可変セッションから取得します。  
   Aの受付後に`listSessions`を読み直すため、その間にBがセッションを変更すると、AのturnIdにBのinstance・driverを記録します。変更後のセッションを返す検証では、Claudeの担当とAのCodexモデルを組み合わせて記録しました。最初の担当記録を残す規則により、後から訂正できません。  
   **直し方：** 実際に送信したinstance・driver・解決済みモデルを受付結果に固定し、その結果から担当を記録してください。世代管理の追加とは別に必要です。

Minor

1. [ProviderCommandReactor.test.ts:4624](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:4624) — `inputTextExpanded`の実サービスの検証がありません。  
   新テストはmockにtrueが渡ったことを確認するだけです。  
   **直し方：** ProviderServiceのテストで、引用・添付パス・captured-windowの二重追記防止、上限超過の拒否、添付のネイティブ送信、false／未指定時の従来動作を確認してください。

serverとcontractsの型チェックは成功しました。再現には独自のインメモリ検証を使っており、報告されたVitest一式は再実行していません。クライアントから`inputTextExpanded`を指定できる経路は見つかりませんでした。

次の部分（retry/resolve/abort と起動時の復旧）に進んでよいか：**現状は不可です。先にMajorを修正して再レビューしてください。**

### 第2巡（Codex 原文）

判定：**Yellow**。Blocker 0件、Major 3件、Minor 2件です。コードは変更していません。

requestのworker内での確定、乗り換え中の失敗処理、完了の同一コミット、旧cursorの遮断、runtimePayloadの置き換えは修正を確認しました。

Blocker：なし。

Major

1. [ProjectionThreadProviderSwitches.ts:258](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:258)、[ProviderCommandReactor.ts:1335](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1335) — `createdBefore`では保存からreactor処理までの隙間を塞げません。  
   AとBが先に保存され、workerがAを処理している間、BはNULLのままです。Bの`createdAt`がrequestの時刻以前なら履歴に入ります。実際のengineとSQLで、Aだけをpendingにした状態からBを取得することを再現しました。後でBを拒否しても、保存済みパケットからは消えません。`countDeliveredUserMessages`にも同じNULLが混入します。また、クライアント時計が進んでいれば、配達済みの履歴を時刻条件で除外します。  
   **直し方：** 新しい送信は保存と同じコミットでpendingにしてください。サーバー側で開始時のフラグを確定し、内部コマンドに初期送信状態を渡せば、deciderが設定を読む必要はありません。旧データのNULLとの区別を永続化してください。A・Bを保存してworkerの再開を待つテストと、端末時計がずれたテストが必要です。

2. [ProviderCommandReactor.ts:1708](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1708)、[providerSwitchFlow.ts:363](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:363) — 通常送信の受付済み発言がpendingのまま残ります。  
   担当記録のdispatch失敗はログだけで終了します。SQLの失敗注入で、pendingからdeliveredへの確定が失敗するとpendingに残ることを確認しました。また、pending化後にフラグをoffにすると、受付成功後の担当記録を省略することも再現しました。実際には届いた発言を次の引き継ぎから除外し、起動時にpendingを一律rejectedにする復旧とも矛盾します。  
   **直し方：** 保持した受付結果から担当記録を冪等に再試行する経路を設けてください。追跡を開始した発言は、途中でフラグがoffになっても送信状態を確定させます。受付後の記録失敗とフラグ切り替えをテストしてください。

3. [ProviderService.ts:1617](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1617) — 受付結果のモデルがまだ固定されていません。  
   `modelSelection`を省略した送信では、adapterの受付、binding更新、analyticsの後に`listSessions`からモデルを読みます。その間に次の送信でモデルが変わると、前のturnIdに新しいモデルを返します。実際のsendTurnの処理を使った障害注入で、モデルAで受付後にモデルBを返すことを再現しました。モデル指定時も要求値を返しており、adapterが別名から解決したモデルとは限りません。  
   **直し方：** adapterの受付結果に、そのターンの解決済みモデルを含めてください。ProviderServiceはその値を使い、受付後のセッション一覧から取得しないようにします。指定省略時のモデル変更と、別名の解決をテストしてください。

Minor

1. [ProviderCommandReactor.ts:1335](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1335)、[同:316](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:316) — 圧縮待ちの通常発言を取り消してもpendingが残ります。  
   待機中の発言もpendingになりますが、`cancelTurnsAfterCompaction`は失敗activityを追加するだけです。圧縮失敗や割り込みでキューを取り消した後も送信状態が終端になりません。  
   **直し方：** 取り消した通常発言をrejectedまたはcancelledに確定し、取り消し後の状態を検証してください。

2. [ProjectionThreadProviderSwitches.ts:590](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/persistence/Layers/ProjectionThreadProviderSwitches.ts:590) — 会話の有無の判定に全件COUNTを使っています。  
   呼び出し側が必要とするのは1件でも存在するかだけですが、フラグonの通常送信ごとに全対象発言を数えます。  
   **直し方：** `EXISTS`、または`SELECT 1 LIMIT 1`による存在判定に置き換えてください。

serverとcontractsの型チェックは成功しました。障害注入とSQLの確認は独自のインメモリ検証です。報告されたVitest一式は再実行していません。

次の部分（retry/resolve/abort と起動時の復旧）に進んでよいか：**現状は不可です。先にMajor 3件を修正して再レビューしてください。**

### 第3巡（Codex 原文）

判定: **Yellow**。Blockerなし、Major 4件、Minorなし。コードは変更していません。

1. Major / [decider.ts:1575](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:1575)  
   **bootstrapで先行保存した発言がpendingになりません。**  
   [ws.ts:1449](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/ws.ts:1449)で発言を保存すると、後続turn-startでは`userMessageEvent === null`となり、`trackDelivery: true`でもpendingイベントを出しません。SQLでも`delivery_state=NULL`を確認しました。送信失敗時も`isTracked`がfalseとなり、未送信の発言を配達済みの履歴として扱います。  
   直し方: bootstrapの先行保存にも追跡指定を渡し、appendとpendingを同じコミットで出してください。先行保存後の送信失敗をテストに追加してください。

2. Major / [providerSwitchFlow.ts:349](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:349)  
   **モデルを返さないアダプターでは、受付済み発言がpendingに残ります。**  
   Cursor・Grok・OpenCode・Antigravityの送信結果には`model`がありません。`modelSelection`を省略した通常送信ではProviderServiceも補えず、このreturnで担当記録とdelivered確定を両方省きます。追跡指定は全プロバイダーに付くため、乗り換えの許可リスト外でも発生します。  
   直し方: 全アダプターで受付時のモデルを返すか、担当情報が不足しても受付済み発言のdelivered確定は行ってください。各アダプターでモデル指定なしの送信を検証してください。

3. Major / [ProviderCommandReactor.ts:1367](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1367)、[ProviderService.ts:1589](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1589)  
   **受付後の保存失敗を送信拒否にしています。**  
   アダプターがturnIdを返した後でも、bindingのupsertが失敗するとsendTurn全体が失敗します。reactorは受付前後を区別せずrejectedを記録する実装です。受付成功後のupsert失敗を注入して確認しました。届いた発言を履歴から除外し、再送による二重実行につながります。  
   直し方: 受付済みturnIdを含む結果またはエラーを返し、受付前の失敗と区別してください。受付済みなら担当記録とdeliveredの保存を再試行し、rejectedにはしないでください。

4. Major / [providerSwitchFlow.ts:377](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:377)、[ProviderCommandReactor.ts:1702](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1702)  
   **再試行が尽きると、復旧に必要な受付結果が失われます。**  
   担当記録が保存されなければ、ユーザー発言の`turn_id`はNULLのままで、受付結果はログだけで終わります。A、Bの順に要求を保存してAの開始を記録し、担当保存を全試行失敗させると、A/Bともpending・`turn_id=NULL`で、Aターンの`pending_message_id`はBでした。既存のpending対応から復旧すると、Bを誤ってdeliveredにする経路があります。  
   直し方: messageId・turnId・受付時モデルの正しい組を永続化し、再起動後も保存を再試行できるようにしてください。保存できなかった発言は受付不明として扱う必要があります。予定している復旧を、既存の`pending_message_id`だけから行うことはできません。

server・contractsの型チェックは成功しました。SQLテスト本体19件と上記の反例を読み取り専用ハーネスで確認しました。Vitest全体は再実行していません。

次の部分（retry/resolve/abortと起動時の復旧）に進んでよいか: **現段階をGreenとして確定するのはまだ勧めません。** 上記を修正し、特に受付結果の保存方法を決めてから進んでください。

### 第4巡（Codex 原文）

判定: **Yellow**。Blocker 0件、Major 1件、Minor 1件。

前回のMajor 4件は解消と判断します。受付結果を保存できなかった発言をpendingのまま残し、推測で確定せず引き継ぎから除く新方針も妥当です。

1. Major / [providerSwitchFlow.ts:601](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:601)、[decider.ts:2384](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:2384)  
   **乗り換え経路で、解決済みモデルを担当記録に使っていません。**  
   flowはsendTurnの結果をturnIdだけに変換し、deciderは`pending.to.model`を保存します。

   実際のflow・engine・SQL projectionを通した検証で、要求が`opus-5.5`、受付結果が`claude-opus-5-5`でも、担当記録は`opus-5.5`でした。同じターンへの追加指示で`claude-opus-5-5`を記録すると、モデルを変えていないのに`changed_mid_turn=true`になります。§5.4の規則に反します。

   直し方: 受付結果のmodelをdeliveredコマンドまで渡し、担当イベントにはその値を使ってください。同一コミットでの確定を維持し、別名での乗り換え後に同じモデルで追加指示するテストを追加してください。

2. Minor / [ProviderService.ts:1576](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1576)、[ProviderService.ts:1599](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1599)  
   **受付後の記録失敗を成功として返す変更に、回帰テストがありません。**  
   今回追加したassociation・binding保存失敗の分岐を、既存テストでは検証していません。読み取り専用ハーネスでは、この2処理が失敗しても受付結果が返ることを確認しました。

   直し方: 受付後にbinding保存を失敗させ、成功結果が返ること、再送されないこと、発言がrejectedにならないことを固定テストに追加してください。

server・contractsの型チェックは成功。SQLテスト本体19件と反例はインメモリハーネスで確認しました。Vitest全体は再実行していません。コード変更なしです。

次の部分（retry/resolve/abortと起動時の復旧）に進んでよいか: **Majorの担当モデル誤記録を修正してから進むことを勧めます。** pendingに関する新方針は、そのまま採用して構いません。

### 第5巡（Codex 原文）

判定: **Green**。Blocker 0件、Major 0件、Minor 0件。

前回のMajor・Minorは解消しました。実際のflow・engine・SQL projectionで解決済みモデルが保存され、同じモデルで追加指示しても`changed_mid_turn=false`になることを確認しました。model省略時の互換性と、受付後のbinding保存失敗を検証する固定テストも確認しています。

server・contractsの型チェックは成功。SQLテスト本体19件と前回の反例は、読み取り専用ハーネスで再検証しました。Vitest全体は再実行していません。コード変更なしです。

**次の部分（retry/resolve/abortと起動時の復旧）に進んでよいです。** 復旧でも、§4.5の「pendingを推測でdelivered／rejectedに変えない」方針を維持してください。

## コードレビュー: Phase 1 第2部分（retry・resolve・abort の処理と起動時の復旧、2026-10-06）

経過: 第1巡 Red（Major7）→ 第2巡 Red（Major3・Minor2）→ 第3巡 Red（Major3）→ 第4巡 Red（Major1）→ 第5巡 Red（Major1）→ 第6巡 Red（Major1）→ 第7巡 Green

### 第1巡（Codex 原文）

判定: **Red**

Blockerなし、Major 7件、Minorなしです。二重送信と、再起動後に操作を復旧できない経路があります。

1. Major — 同じswitchを二重にresumeして送信できる  
   [ProviderCommandReactor.ts:2007](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:2007)、起動時側:2200

   activation後の復旧とretry/resendイベントは、独立してresumeをforkします。retryがDBへ反映された後、イベント処理前に復旧がその状態を読むと、両方から同じswitchを進められます。同じattemptIdのplannedは冪等として受理されるため、二重実行を防ぎません。ハーネスでsendTurnが2回になることを確認しました。

   直し方: threadId/switchIdごとに実行中のfiberを管理し、再開を一本化してください。復旧対象の確定と通常イベントの処理開始にも順序を設けます。activation直後のretryと、送信受付待ちを重ねるテストが必要です。

2. Major — resendの許可を古い成功記録で閉じる  
   [providerSwitchFlow.ts:849](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:849)

   `submit成功 → delivered記録失敗 → unknown-delivery → resolve(resend) → 新しいsubmit前に再起動`で起きます。resendAllowedを確認せず、前のsubmitのturnIdでdeliveredにしてしまい、許可された再送を行いません。実際のengineとSQL保存を使ったハーネスでも再現しました。

   直し方: 未使用のresendAllowedを復旧判定に反映し、古い成功記録で現在の再開を完了させないようにしてください。この順序と、再開後のstartだけがplannedで残る場合をテストに加えます。

3. Major — abort後の掃除を再起動で失う  
   [providerSwitchFlow.ts:795](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:795)、復旧の除外条件:836

   abortは先にpendingを消し、その後でセッション停止とモデル復元を行います。コミット後・掃除前の停止やreleaseの失敗では、次の起動時に`pending === null`として対象外になります。白紙の新セッションや新しいモデル選択が残り、解決済みなのでabortも再受付できません。lastClosedにはreturnToPreviousと掃除の完了記録がありません。

   直し方: returnToPreviousと掃除の未完了/完了を永続化し、未完了のabortを起動時にも処理してください。掃除が終わるまで通常送信を拒否し、abort保存直後の再起動と停止失敗をテストします。

4. Major — 同じinstanceの別モデルをキャッシュから選んでしまう  
   [providerSwitchFlow.ts:774](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:774)、元に戻す側:817

   cachedSelectionはinstanceIdだけを照合します。同じinstanceのモデルAからBへ乗り換える際、開始失敗後のretryではキャッシュのAを再開先に使えます。開始成功後のabort(returnToPrevious)では、更新済みのキャッシュBを旧モデルとして復元する誤りです。両方をハーネスで確認しました。

   直し方: 保存済みpending.to/lastClosed.fromのモデルを必ず使用してください。完全な選択をキャッシュから使う場合はモデルまで照合するか、from/toの選択を別々に保持します。同一instance・異なるモデルのretryとabortを追加してください。

5. Major — 一件の復旧失敗で他のswitchも復旧しない  
   [providerSwitchFlow.ts:834](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:834)、[ProviderCommandReactor.ts:2208](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:2208)

   ループ内のdispatchが一度失敗すると、集めたtoResumeも返されず、後続スレッドも処理されません。呼び出し側はログだけで終了します。残ったin-progressの操作は通常送信を拒否し、retry/abort/resolveの受付条件にも入りません。

   直し方: スレッドごとに失敗を処理して他の復旧を続け、失敗した操作にも再試行または判断待ちへ移す経路を設けてください。複数スレッドの途中で一件だけ記録を失敗させるテストが必要です。

6. Major — 復旧でプロバイダーの報告モデルを失う  
   [providerSwitchFlow.ts:853](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:853)

   通常経路ではsubmit-succeededにturnIdだけを保存し、報告モデルは次のdeliveredコマンドに渡しています。その間に停止すると、復旧はmodelなしでdeliveredを作り、担当記録にpending.to.modelの要求名を使います。別名を解決するプロバイダーでは、実際の担当モデルと異なる記録です。

   直し方: 成功したsubmitのイベントと状態に報告モデルも保存し、復旧のdeliveredへ渡してください。別名を使い、submit成功保存後・delivered前に停止するテストを追加します。

7. Major — discard後、引き継ぎ未確認のセッションをnative継続する  
   [ProviderCommandReactor.ts:2079](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:2079)、[providerSwitchFlow.ts:236](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:236)

   送信が受付前に失敗してdiscardした場合も、新セッションは白紙のまま残ります。次のdecideではawaitingHandoffDeliveryを常にfalseにするため、nativeとして通常本文だけを送ります。セッションを止めない処理は§8.2に合いますが、§3.1の「配達前の新セッションをnativeの根拠にしない」条件を満たしません。

   直し方: セッションと乗り換え操作の対応、引き継ぎの配達確認を保持し、未確認ならnativeの根拠から外してください。実行中のターンを停止せず、次の送信時に再判定します。discard後の通常送信までテストに加えてください。

server・contractsの型チェックは通過しました。再現確認には、コードを変更せず実行するインメモリのハーネスを使用しています。

**次の部分（世代の付与と古いイベントの破棄）に進んでよいか: 現状では不可です。** 上記の修正と境界条件のテストを先に完了してください。

### 第2巡（Codex 原文）

判定: **Red**

Blockerなし、Major 3件、Minor 2件です。前回の再送許可・キャッシュ選択・スレッド別復旧・報告モデルの問題は解消しています。二重送信も防げていますが、後始末の取りこぼしと、discard後のセッション保護に問題が残ります。

1. Major — runExclusiveがabortの後始末を取りこぼす  
   [providerSwitchFlow.ts:145](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:145)、再実行側:152

   実行中に別の処理が来るとrerunだけを立て、最初に渡されたrunを繰り返します。resumeがawait-userを保存した後、markSessionFailedの完了前にabortすると、cleanupは実行されずに戻ります。その後、元のresumeがclosingを読んで終了するため、後始末が成功可能でもclosingに残ります。ハーネスではrelease 0回、close 0件でした。

   直し方: 後から来た処理も保持するか、現在のpending・switchId・statusからresume/cleanupを選ぶ共通処理を再実行してください。await-user保存後のセッション更新をDeferredで止め、その間にabortするテストが必要です。

2. Major — 受付不明にすると実行中のターンまでerrorにする  
   [providerSwitchFlow.ts:373](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:373)、[ProviderCommandReactor.ts:1321](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1321)

   markSessionFailedはunknown-deliveryでも呼ばれ、既存処理の:442でrunningもerror・`activeTurnId: null`へ変えます。turn.startedが届いた後に送信の応答やdeliveredの記録が失敗すると、実際には作業中でも、その記録を消してしまいます。

   その後discardして送信すると、decideの作業中ガードを通過し、乗り換えの旧セッション停止で実行中のターンを止められます。実際のengine・SQLを使ったハーネスで、running→error/nullと、その後のhandoff許可を確認しました。

   直し方: startingの残留解消と、runningのターンの扱いを分けてください。受付不明でも観測済みのrunning/activeTurnIdを保持し、decideでもプロバイダーの稼働状態を確認します。`turn.started → 記録失敗 → discard → 次の送信`でターンを止めないテストが必要です。

3. Major — 旧セッションを残したabortでも未確認フラグを消す  
   [providerSwitchState.ts:575](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:575)、[providerSwitchFlow.ts:862](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:862)

   discardで未確認になったセッションへ再び引き継ごうとし、旧セッションの停止が失敗してrequestedのままabortすると起きます。後始末は旧セッションに触れませんが、closedでhandoffUnconfirmedInstanceIdを無条件にnullにします。その結果、引き継ぎを受けていないセッションをnative継続できます。ハーネスでも停止0回のままフラグが消え、nativeと判定されました。

   直し方: closedでの無条件クリアをやめてください。対象セッションを停止したことが確認できた場合、または新しい引き継ぎのdelivered時に解除します。`discard → 停止失敗 → abort → 次の送信`までテストしてください。

4. Minor — 成功結果の冪等照合にmodelが含まれない  
   [providerSwitchState.ts:281](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/providerSwitchState.ts:281)

   記録済みと同じattemptId・turnIdなら、modelだけ異なるsucceededも受理します。イベントには新しいmodelを保存しますが、projectorは結果済みとして無視するため、成功を返した内容と状態が一致しません。model Aの後にBを送って受理され、状態にはAが残ることを確認しました。

   直し方: modelも結果の同一性照合に含めてください。旧イベントのmodel未設定の扱いも決め、同じmodelの重複と異なるmodelの再記録をテストします。

5. Minor — 復旧と判断待ちの記録が両方失敗してもログが出ない  
   [providerSwitchFlow.ts:948](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:948)

   awaitUserの失敗を無視してhandledを返すため、呼び出し元のログ処理にも届きません。ハーネスでは両方のdispatchを失敗させてもrecoverThreadが成功終了し、状態はin-progressのままでした。「それも失敗すればログのみ」という今回の方針を満たしていません。

   直し方: 最後の失敗をthreadId・switchId付きでログに残してください。他のスレッドの復旧は継続する形で構いません。

server・contractsの型チェックは通過しました。再現確認は読み取り専用のハーネスで行い、コードは変更していません。Vitest全体は再実行していません。

**次の部分（世代の付与と古いイベントの破棄）に進んでよいか: 現状では不可です。** Major 3件を修正し、競合と後続操作のテストを通してから進めてください。

### 第3巡（Codex 原文）

判定: **Red**

Blockerなし、Major 3件、Minorなしです。前回の取りこぼし・未確認フラグ・model照合・復旧ログは解消しました。running保護は一部解消で、確認と更新の間の競合が残ります。

1. Major — binding保存失敗後のabortが新セッションを残して解決する  
   [providerSwitchFlow.ts:890](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:890)、[ProviderService.ts:1411](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1411)

   startSessionはプロバイダーの開始後にbindingを書きます。そこで保存が失敗すると、新セッションは生きていますが、bindingは停止済みの旧instanceを指したままです。flowはstartをfailedとして判断待ちにします。その後のabortではbindingがtoと違うため停止を省略し、closeで解決してしまいます。残ったセッションとbindingの不一致で、ProviderService.listSessionsも失敗します。

   実装のstartSession/listSessionsを使ったハーネスで、`開始失敗 → abort後も新セッションが生存 → pendingはnull → listSessions失敗`を確認しました。

   直し方: startSession側で開始後の内部記録失敗時に作ったセッションを停止するか、abortの後始末で実際に開始したtoのセッションも確認してください。停止完了を確認するまでcloseせず、adapter開始成功後のbinding書き込みだけを失敗させるテストが必要です。

2. Major — startingの確認後にrunningへ変わると上書きする  
   [ProviderCommandReactor.ts:1324](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1324)、既存ヘルパー:428・442

   最初のresolveThreadShellでstartingを確認した後、呼び出すヘルパーが再び状態を読みます。この間にturn.startedがrunning/activeTurnIdを保存すると、ヘルパーはそのrunningをerror・`activeTurnId: null`に変えます。ヘルパーの読み取り後からdispatchまでの間にも同じ競合があります。

   実際のengine・SQLを使い、最初の確認直後にrunningを保存するとerror/nullになることを確認しました。プロバイダー側の作業中ガードは修正済みですが、スレッドの実行状態は失われます。

   直し方: startingだけを変更する条件を、deciderで現在状態を照合する条件付き更新にしてください。turn.startedの反映を確認と更新の間に挟み、runningとactiveTurnIdが残るテストが必要です。同じ世代の通常イベントでも起きるため、次の部分の古いイベント破棄だけでは解決しません。

3. Major — driveThreadの後始末だけ再試行しない  
   [providerSwitchFlow.ts:865](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:865)、再実行時の失敗処理:157

   通常のcleanupと起動時復旧には再試行がありますが、実行中のabortをdriveThreadへ回した場合はfinishAbortedSwitchを一度だけ呼びます。一時的な停止失敗でも、警告を出して終了し、closingに残ります。

   ハーネスでは、最初の停止だけを失敗させると停止1回・close 0件で終了しました。後始末を明示的に再実行すると、次の停止は成功して解決します。

   直し方: 再試行付きの後始末を共通化し、driveThreadからも呼んでください。await-user保存後の処理をDeferredで止め、abortを重ね、最初の停止だけ失敗させるテストを追加します。

コードは変更していません。server・contractsの型チェックは通過しました。再現確認はインメモリのハーネスによるもので、Vitest全体は再実行していません。

**次の部分（世代の付与と古いイベントの破棄）に進んでよいか: 現状では不可です。** Major 3件を修正し、対応する境界条件のテストを通してから進めてください。

### 第4巡（Codex 原文）

判定: **Red**

Blocker: なし。Major: 1件。Minor: なし。

**Major 1 — binding保存失敗後の停止も失敗すると、新セッションを残したままabortが完了する**

対象: [ProviderService.ts:1419](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1419)、[providerSwitchFlow.ts:891](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:891)

開始後のbinding保存に失敗すると新セッションを停止しますが、その停止の失敗はログだけにしています。bindingが旧instanceのままなので、続くabortの後始末では新セッションを停止せず、closeを確定します。

binding書き込み失敗と「最初の停止だけ失敗」を組み合わせて再現しました。abort後も新セッションが生存し、pendingはnullになります。さらに、[ProviderService.ts:2111](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:2111)の不一致チェックでlistSessionsも失敗します。

直し方: 開始を取り消す停止を再試行し、生存確認を行ってください。停止できない場合も、bindingの保存成功に依存せず、作成したinstanceを後始末できるようにする必要があります。停止を確認するまでclosingを解決せず、この複合失敗をテストに追加してください。

前回の残り2件（expectedStatusによる競合拒否、重なったabortの後始末再試行）は修正を確認しました。server/contractsの型チェックは通過。再現は現行処理を使うインメモリハーネスで確認し、Vitestは再実行していません。コードは変更していません。

次の部分（世代の付与と古いイベントの破棄）に進んでよいか: **上記Majorを修正してから進んでください。**

### 第5巡（Codex 原文）

判定: **Red**

Blocker: なし。Major: 1件。Minor: なし。

前回のMajorは解消しました。abortでinstance指定の停止が行われ、停止失敗中はclosingに残り、停止できれば解決することを確認しました。

**Major 1 — 取り消しに失敗して残った新セッションをretryでは回収できない**

対象: [providerSwitchFlow.ts:511](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:511)、[ProviderService.ts:2142](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:2142)

binding保存と取り消しの停止が失敗すると、新セッションが生きたままfailed-retryableになります。この状態でretryすると、残存セッションを片付ける前にlistSessionsを呼ぶため、旧bindingとの不一致で失敗します。新しいstart試行に進めず、再びfailed-retryableとなる経路です。

保存と停止の障害を解消してから2回retryしても、開始試行は1件のまま、停止回数も増えないことを再現しました。abortでは回復できますが、「もう一度試す」では回復できません。

直し方: 成功が記録されていないstart試行の再開では、listSessionsより先にto.instanceIdの残存セッションを停止・確認し、その後で新しい開始試行に進めてください。今回の複合失敗から、障害解消後のretryでdeliveredまで進むテストも追加してください。

server/contractsの型チェックは通過。再現は現行処理を使うインメモリハーネスで確認しました。Vitestは再実行していません。コード変更はありません。

次の部分（世代の付与と古いイベントの破棄）に進んでよいか: **上記Majorを修正してから進んでください。**

### 第6巡（Codex 原文）

判定: **Red**

Blocker: なし。Major: 1件。Minor: なし。

前回のMajorは解消しました。残存セッションをinstance指定で停止し、retryで再開始してdeliveredまで進むことを確認しました。

**Major 1 — 別スレッドの残存セッションが、復旧・retryを妨げる**

対象: [providerSwitchFlow.ts:523](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:523)、[ProviderCommandReactor.ts:613](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:613)、[ProviderService.ts:2142](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:2142)

listSessionsのbinding不一致は`Effect.die`で返されます。`orElseSucceed`は通常のエラーだけを拾うため、この不一致を「稼働していない」として処理できません。

Bに未記録の新セッションが残り、Aにstart成功記録がある状態でAを再開すると、Bの不一致でAもfailed-retryableへ戻ります。現行flowと実際のlistSessionsを使い、Aの停止・開始・送信がすべて0回になることを再現しました。

さらに、handoff開始でもensureSessionForThreadが全スレッドのlistSessionsを呼びます。flow側のcatchだけを直しても、開始時に同じ不一致で失敗する経路が残ります。

直し方: 乗り換えの稼働確認とhandoff開始では、対象スレッドだけのセッション取得・検証にしてください。falseへのフォールバックを維持するなら、`Effect.die`も拾い、割り込みは伝播させる必要があります。Bを判断待ちに残したまま、Aが復旧・retryでdeliveredまで進む2スレッドのテストも追加してください。

server/contractsの型チェックは通過。実行確認はインメモリハーネスで行い、Vitestは再実行していません。コード変更はありません。

次の部分（世代の付与と古いイベントの破棄）に進んでよいか: **上記Majorを修正してから進んでください。**

### 第7巡（Codex 原文）

判定: **Green**

Blocker: なし。Major: なし。Minor: なし。

前回のMajorは解消しました。別スレッドBのbinding不一致を残したまま、Aのretry・起動時復旧がそれぞれ開始1回・送信1回でdeliveredまで進むことを確認しました。handoff開始の照会もlistThreadSessionsを使い、通常経路は従来のlistSessionsを維持しています。

server/contractsの型チェックとgit diff --checkは通過。実行確認は現行処理を使うインメモリハーネスで行いました。Vitestは再実行していません。コード変更はありません。

次の部分（世代の付与と古いイベントの破棄）に進んでよいか: **進んでよいです。**

## コードレビュー: Phase 1 第3部分（セッション世代の付与と古いイベントの破棄、2026-10-06）

経過: 第1巡 Red（Major4・Minor1）→ 第2巡 Red（Major2）→ 第3巡 Green

### 第1巡（Codex 原文）

判定: **Red**

Blocker: なし。Major: 4件。Minor: 1件。

1. **Major — native resumeの保存失敗で、新セッションのイベントを捨て続ける**

   [ProviderService.ts:1286](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1286)

   新セッション開始後のbinding保存に失敗すると、停止せずにliveだけ旧世代へ戻します。世代2のセッションが生存し、live=1となる状態を再現しました。次の送信はそのセッションを使いながらgeneration=1を返し、実際の世代2のイベントはすべてstaleになります。

   **直し方:** 保存失敗時にも新セッションの停止・生存確認を行い、実際のセッションとliveを一致させてください。停止できない場合にも復旧できる扱いが必要です。保存失敗後の次の送信までテストしてください。

2. **Major — 通常の再開始で、旧ターンの終了処理を失う**

   [ProviderService.ts:1495](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1495)、[ClaudeAdapter.ts:4338](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:4338)

   乗り換え済みスレッドで通常の再開始をすると、liveを新世代へ変えた後にClaudeAdapterが旧セッションを止めます。その停止で生成する`turn.completed(interrupted)`や`item.completed`は旧世代なので捨てられます。現行関数で中断イベントがstaleになることを確認しました。終了イベントに依存する旧ターン・発言・checkpointの後始末が抜けます。

   **直し方:** 旧ターンの終了・取消を確定してからliveを切り替えるか、再開始側で同じ後始末を明示的に行ってください。乗り換え後の実行中ターンで、モデル選択オプションやruntimeModeを変更するテストが必要です。

3. **Major — Claude内部再開始のFIFOの前提が成り立たない**

   [ClaudeAdapter.ts:2138](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:2138)、[ClaudeAdapter.ts:4833](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:4833)

   SDKのcanUseToolはrunPromiseで動き、stopSessionInternalが待つstreamFiberとは別です。旧ExitPlanModeコールバックをイベント生成前で待たせ、停止・新セッション開始後に再開すると、`session.started`の後に旧`turn.proposed.completed`が同じ世代で追加されました。FIFOは、停止しきれていない生成元からの追加を防げません。

   **直し方:** SDKコールバックも追跡して停止・完了待ちを行うか、内部再開始にも別の識別子を付けて旧生成元を拒否してください。遅延コールバックのテストと、§17-3の根拠の修正が必要です。

4. **Major — 送信結果の世代を、受付後のliveから取り直している**

   [ProviderService.ts:1784](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:1784)

   adapterの受付後、binding保存やanalyticsを待ってからliveを読みます。その間に再開始すると、旧セッションで受け付けたターンに新しい世代を付けます。世代2で受付後にliveを3へ変えると、結果がgeneration=3になることを再現しました。

   **直し方:** adapterの受付結果に、そのセッションの世代を固定して返し、ProviderServiceでもその値を使ってください。P7の担当記録まで含め、受付後・記録前に再開始するテストが必要です。

5. **Minor — 失敗済みの最大世代を再利用できる**

   [ProviderService.ts:424](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ProviderService.ts:424)

   世代2を予約してundoするとfloor=2、live=1になります。要求値2は拒否されず、古い世代2のイベントも有効になります。現行flowのmax+1では避けられていますが、サービスの検証では防げません。

   **直し方:** 既に配った世代は`requested <= floor`で拒否してください。失敗・解放後のfloorと同値の要求をテストに追加してください。

server/contractsの型チェックとgit diff --checkは通過。再現は現行関数を使うインメモリハーネスで行い、Vitestは再実行していません。コード変更はありません。

**次の部分（CHANGESの差分、巻き戻し境界、/compact）には、上記Majorを修正してから進んでください。**

### 第2巡（Codex 原文）

判定：**Red**。Blocker 0件、Major 2件、Minor 0件です。

前回のMajor 1・2・4とMinorは解消しました。Major 3は一部解消です。下限方式で旧担当の世代を除外し、通常再開始の終了イベントを残す方針は妥当です。開始失敗後の残存セッションは乗り換え先の世代なので、イベントを受け付けること自体は追加の指摘にしていません。retry前の解放で下限を上げる処理も確認しました。

Blocker：なし。

Major：

1. **置換済みのClaude contextが、後続セッションの停止後に再び有効になる**  
   [ClaudeAdapter.ts:2141](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:2141)

   `current`が`undefined`なら通すため、旧context AをBへ置換し、Bも通常停止してmapが空になると、Aの遅いコールバックを受け付けます。再現では、新セッションの終了後に旧`request.opened`が入り、世代判定も`stale=false`でした。内部再開始は同じ世代なので、下限方式でも除外できません。§17-3の保証が成立していません。

   **直し方：** mapが空の場合も除外するよう、`sessions.get(threadId) !== context`で判定してください。通常停止の終了イベントはmap削除前に出るため維持できます。「置換→新セッションも停止→旧コールバック」と、通常停止の終了イベントを確認するテストを追加してください。

2. **乗り換え経路が受付結果のgenerationを捨て、担当記録に開始試行の世代を使う**  
   [providerSwitchFlow.ts:703](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:703)、[decider.ts:2377](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/decider.ts:2377)

   開始試行が世代2で成功したあと、パケット作成中などにセッションが失われると、`sendTurn`のnative resumeが世代3を作れます。ProviderServiceは3を返しますが、flowは`turnId`と`model`しか保存せず、deciderは開始試行の2を担当記録に入れます。この不一致を再現しました。§15 P7の「受付結果と同時に固定する」規則を満たしません。

   **直し方：** submitの成功結果に受付世代を保存し、deliveredの担当記録と起動時復旧でその値を使ってください。開始試行の予約世代とは分け、旧イベントもdecodeできる任意項目にしてください。「開始2→送信直前に消失→native resume 3」と、その成功記録からの復旧をテストに追加してください。

Minor：なし。

server・contractsの型チェックはエラー0でした。再現には実装を使うメモリ上のハーネスを使用しました。Vitestは再実行していません。コードとファイルは変更していません。

**次の部分（CHANGESの差分、巻き戻し境界、/compact）に進んでよいか：現時点では不可です。** 上のMajor 2件を直してから進んでください。

### 第3巡（Codex 原文）

判定：**Green**。

- Blocker：なし
- Major：なし
- Minor：なし

前回のMajor 2件は解消しています。

1. [ClaudeAdapter.ts:2141](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/provider/Layers/ClaudeAdapter.ts:2141)  
   後続セッションの停止後も旧contextを除外します。通常停止の`turn.completed`と`session.exited`が届くことも確認しました。

2. [providerSwitchFlow.ts:729](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/providerSwitchFlow.ts:729)  
   受付世代3が成功記録・delivered・担当記録まで保持されます。起動時復旧でも世代3を使い、再送しません。旧状態のdecodeと、受付世代が異なる重複結果の拒否も確認しました。

server・contractsの型チェックはエラー0でした。再現確認には実装を使うメモリ上のハーネスを使用し、Vitestは再実行していません。コードとファイルは変更していません。

**次の部分（CHANGESの差分、巻き戻し境界、/compact）に進んでよいと判断します。**

## コードレビュー: Phase 1 第4部分（変更内容の差分・巻き戻しの境界・/compact、2026-10-06）

経過: 第1巡 Red（Major1）→ 第2巡 Red（Major2）→ 第3巡 Green

### 第1巡（Codex 原文）

判定：**Red**。Blocker 0件、Major 1件、Minor 0件です。

Blocker：なし。

Major：

1. **/compactが現在の担当で圧縮せず、選択中の別ドライバーを理由に失敗する**  
   [ProviderCommandReactor.ts:1655](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1655)、[ProviderCommandReactor.test.ts:4809](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:4809)

   Codexで会話したあとClaudeを選んで`/compact`を送ると、選択先の`modelSelection`を`ensureSessionForThread`へ渡すため、既存の別ドライバー拒否で終了します。`compactThread`には到達しません。実装を使った再現でも、この拒否を確認しました。

   追加テストは`provider.turn.start.failed`を待っており、圧縮の失敗を期待しています。これは既存コードに残っている設計未達です。§9.3の決定9では、現在の担当で圧縮し、選択先への乗り換えは次の通常発言まで保留します。

   **直し方：** 圧縮用の`modelSelection`をbinding・稼働中セッションの現在の担当から求め、`ensureSessionForThread`と`compactThread`へ渡してください。選択中の移行先は予約として保持し、圧縮用のキャッシュを移行先の値で更新しないようにします。テストでは「現在のCodexで圧縮が成功し、switchもreleaseもなく、次の通常発言でClaudeへ乗り換える」を確認してください。

Minor：なし。

CHANGESは最新readyを選び、空白差分を含めて取得しています。renameの移行先パスと取得失敗時の`null`も確認しました。git出力には既存の10MB上限があります。巻き戻し境界・状態読取失敗は、rollbackとファイル復元の前に失敗activityを出します。本番のLayer構成ではCheckpointStoreが供給されるため、`serviceOption`が常に`None`になる問題は見つかりませんでした。

serverの型チェックはエラー0でした。再現確認にはメモリ上のハーネスを使用し、Vitestは再実行していません。コードとファイルは変更していません。

**次の部分（クライアントへの状態配信とweb UI）には、このMajorを解消してから進んでください。**

### 第2巡（Codex 原文）

判定: **Red（Major 2件）**

前回の「別ドライバーを選ぶと /compact が失敗する」経路は解消しています。CHANGES と巻き戻し境界に追加指摘はありません。

Blocker: なし。

Major:

1. **同じinstanceの別モデルでは、現担当で圧縮する規則が守られません。**  
   [ProviderCommandReactor.ts:474](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:474)

   instanceが一致すると要求値をそのまま返します。そのため、Claudeの旧モデルから別モデルを選んで /compact を送ると、`ensureSessionForThread` が選択先モデルでセッションを再開始し、そのモデルで圧縮します。決定9の「今の担当モデルでだけ実行」に反します。

   また、465行の早期returnにも穴があります。`modelSelection`を省略し、現セッションが停止済みで`thread.modelSelection`が移行先になっている場合は、移行先で開始します。

   **直し方:** フラグonでbindingの担当モデルを特定できる場合は、要求値の有無やinstanceの一致にかかわらず現担当の選択を返してください。同じinstanceのモデル変更と、選択省略・停止済みのテストを追加してください。

2. **選択の解決が失敗すると、圧縮中の印が残り、以後の送信が進みません。**  
   [ProviderCommandReactor.ts:1685](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1685)

   `compactingThreadIds`へ追加した後、失敗回復処理の外で`resolveCompactionSelection`を呼んでいます。キャッシュがない状態で内部の`getThreadShellById`が失敗すると、外側はログだけを出し、`clearCompacting`を実行しません。以後の通常発言はキューに入り続け、/compactの再試行も拒否されます。

   **直し方:** 選択の解決も既存の失敗回復処理の内側へ移し、失敗時に必ず印を消してください。読み取りを1回失敗させ、その後の通常送信が進むテストを追加してください。

Minor: なし。

server型チェックと`git diff --check`は通過しました。上記は実際の関数を読み込んだメモリ上の検証で再現しています。Vitestは今回未実行です。コード・ファイルは変更していません。

**次の部分（クライアントへの状態配信とweb UI）には、Major 2件を直してから進んでください。**

### 第3巡（Codex 原文）

判定: **Green**

Blocker: なし。  
Major: なし。  
Minor: なし。

前回の2件は解消しています。

- **Major 1 — 解消:** 同じinstanceの別モデル、選択省略、停止済みのいずれも現担当で圧縮します。`ownerSelection`は /compact だけが渡し、通常送信の判定には影響しません。
- **Major 2 — 解消:** 設定・binding・スレッドの読み取り失敗が失敗回復処理に入り、圧縮中の印が消えて取消処理まで進むことを確認しました。

実際の関数を使ったメモリ上の検証で、担当選択の優先順位、完全な選択の保持、フラグoff時の扱いも確認しました。server型チェックと`git diff --check`は通過しています。Vitestは今回未実行です。コード・ファイルは変更していません。

**次の部分（クライアントへの状態配信とweb UI）に進んでよいと判断します。**

## コードレビュー: Phase 1 第5部分の前半（クライアントへの状態配信 P11、2026-10-06）

経過: 第1巡 Red（Major2・Minor1）→ 第2巡 Red（Major2）→ 第3巡 Green

### 第1巡（Codex 原文）

判定: **Red（Major 2件、Minor 1件）**

Blocker: なし。

Major:

1. **旧キャッシュからの再開で、乗り換えの状態が欠けたままになります。**  
   [threads.ts:777](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/client-runtime/src/state/threads.ts:777)

   旧クライアントは新イベントを受け取らず、後続のactivityやsession-setでsequenceを進めます。そのキャッシュを新クライアントが読むと、`handoffEvents: true`を付けるだけで保存済みsequenceから再開します。以前の乗り換え・担当記録・送信状態は再送されないため、サーバーに未解決の操作があっても`providerSwitch`が欠けたままです。

   実関数による検証でも、旧形式のキャッシュから`afterSequence: 80`で再開し、スナップショット取得は0回でした。

   **直し方:** キャッシュとメモリ上の保持状態に、handoff対応で取得・適用した状態かを記録してください。不明・非対応から対応へ移る場合は、状態とcursorをリセットしてスナップショットを取得してください。旧キャッシュから更新するテストが必要です。

2. **ウィンドウ付きスナップショットでも、担当記録を全履歴分返します。**  
   [ProjectionSnapshotQuery.ts:1098](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1098)

   担当記録のクエリにはウィンドウ条件がなく、古いページの取得でも全件を再送します。実際のSQLをメモリDBで実行すると、合成データ5,000件をすべて返し、担当記録だけで751,671バイトになりました。`turnLimit`を小さくしても、この読み取り・decode・転送量は減りません。

   **直し方:** ウィンドウ付き読み取りでは、そのページの発言またはターンに対応する記録に限定してください。`mergeOlderPage`にも担当記録のマージを追加し、長い履歴で初回・古いページともに返却件数が限定されるテストを追加してください。

Minor:

1. **ライブの乗り換えイベントでupdatedAtが更新されません。**  
   [threadReducer.ts:762](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/client-runtime/src/state/threadReducer.ts:762)

   サーバーのprojectorとSQLは乗り換えイベントで`thread.updatedAt`を更新しますが、クライアントは`providerSwitch`だけを変えます。同じrequestedイベントで、サーバーは02:00、クライアントは00:00のままになることを確認しました。

   **直し方:** `event.occurredAt`を反映してください。畳み込みが無変化でも時刻が変わる場合を含め、サーバーとの比較テストを追加してください。

本文の除去、RPCの`orchestration:read`認可、パケットのthreadId照合には追加指摘ありません。server・contracts・shared・client-runtimeの型チェックと`git diff --check`は通過しました。再現は個別のメモリ内検証で、Vitestは今回未実行です。コード・ファイルは変更していません。

**後半（webの画面）には、Major 2件を直してから進んでください。**

### 第2巡（Codex 原文）

**判定: Red**

Blocker: なし。Major: 2件。Minor: なし。

前回の旧キャッシュの取り直しと、`updatedAt`の更新は解消しています。担当記録の取得範囲とページの合流に、以下の問題が残っています。

1. **Major — [ProjectionSnapshotQuery.ts:3818](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:3818)**  
   ターンが0件の初回ページでは、`turnLimit`を指定しても内部の`bounds`が`undefined`になり、担当記録を全件取得します。通常送信の履歴をターン0まで巻き戻すと、発言とターンは消えても担当記録は残るため、空のページに過去の担当記録がすべて載ります。

   **直し方:** ページ要求の有無と、本文取得用の`bounds`を分けてください。ページ要求では実際に返した発言のIDで担当記録を絞り、発言0件なら担当記録も0件にします。「担当記録のある履歴を0まで巻き戻した初回ページ」のテストが必要です。

2. **Major — [threads.ts:625](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/client-runtime/src/state/threads.ts:625)**  
   ウィンドウ外のターンに後続の担当記録が届くと、reducerは最初の記録を知らないため、後続記録を最初の担当として保持します。古いページを読んでも、同じ`turnId`の読み込み済み記録が優先され、SQLの確定済み記録を捨ててしまいます。

   例えば、SQL側が「最初のモデルA・`changedMidTurn: true`」、ライブで先に見た記録が「モデルB・`false`」の場合、ページ読み込み後もB・falseのままです。

   **直し方:** ページのSQL記録を最初の担当として採用し、読み込み済みイベントの変更情報を統合してください。「未読ターンへの後続記録→古いページ取得」の順でも、担当Aと`changedMidTurn: true`になるテストを追加してください。

現行関数を使うメモリ内のハーネスで、両経路を再現しました。server・contracts・shared・client-runtimeの型チェックは通過しています。Vitestは今回実行していません。コードは変更していません。

**後半（webの画面）へは、上の2件を修正してから進んでください。**

### 第3巡（Codex 原文）

**判定: Green**

Blocker・Major・Minorはいずれもありません。前回のMajor 2件は解消しています。

- [ProjectionSnapshotQuery.ts:3824](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:3824)：`paged`を`bounds`と独立して判定するため、ターン0件の初回ページでも全件取得しません。発言0件では担当記録のクエリを実行せず、ウィンドウなしの読み取りも維持しています。
- [providerSwitchFold.ts:304](/Users/uedatakehito/Documents/Codex/2026-10-01/task/t3code/packages/shared/src/providerSwitchFold.ts:304)：ページの確定済み記録を採用し、双方の変更フラグとinstance・モデルの相違を統合しています。ライブでモデルBを先に受けても、ページ読み込み後は最初のモデルAと`changedMidTurn: true`が残ります。

現行関数によるメモリ内の検証で、両修正と合流規則16通りを確認しました。キャッシュ再開・パケット本文の除去も確認済みです。対象4パッケージの型チェックはエラー0、`git diff --check`も通過しています。Vitestは今回再実行していません。

**後半（webの画面）に進んでよいです。** コードは変更していません。
