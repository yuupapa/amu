# Grok

Amu は xAI の Grok Build CLI（`grok`）を通して Grok を使います。ログインは Grok のサブスクのアカウントで行い、API キーは使いません。

## 設定から入れてログインする（Amu）

1. **設定 → プロバイダー** で Grok をオンにします。
2. Grok の「アカウント」にあるボタンを押します。Grok Build CLI がまだ入っていないときは「入れてログイン」と出ます。
3. CLI が入っていないときは、Mac 全体に `npm install -g @xai-official/grok` で入れます。入れている間の表示はボタンの下に出ます。npm（Node.js）が無いときは、先に Node.js を入れてください。
4. 続けて `grok login --device-auth` が動き、ログイン用の住所とコードが出ます。住所をブラウザーで開いて、同じコードであることを確かめてから承認します。
5. 承認すると Amu が Grok の状態を確かめ直し、ログインした状態になります。

ログインは CLI のもの（`~/.grok`、または `GROK_HOME`）なので、ターミナルの `grok` と共有します。CLI は Mac 全体に入るので、ターミナルから `grok` や `grok update` もそのまま使えます。ログアウトもこの画面からできます。

入れたあとに「見つけられません」と出たときは、npm が CLI を置いたフォルダーが Amu の `PATH` に入っていません。Amu を再起動するか、Grok の設定で CLI の場所（`npm prefix -g` で出るフォルダーの `bin/grok`）を指定します。
