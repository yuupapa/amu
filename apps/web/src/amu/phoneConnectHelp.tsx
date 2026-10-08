/**
 * Amu: what to try when a phone cannot open the pairing link, under the QR
 * code in Settings → Connections (docs/user/remote-access.md). The first step
 * is the bare address, which shows whether the phone reaches this Mac at all.
 */

/** The address to open first: the link without the pairing token. */
export function reachabilityCheckUrl(pairingUrl: string): string | null {
  try {
    const url = new URL(pairingUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function PhoneConnectHelp(props: { pairingUrl: string }) {
  const check = reachabilityCheckUrl(props.pairingUrl);
  if (!check) return null;
  const tailnet = new URL(check).hostname.endsWith(".ts.net");
  return (
    <details className="rounded-lg border border-border/50 px-2.5 py-1.5 text-2xs text-muted-foreground">
      <summary className="cursor-pointer text-xs font-medium text-foreground">
        スマホでつながらないとき
      </summary>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
        {tailnet ? (
          <li>スマホにも Tailscale を入れ、Mac と同じアカウントでログインしておきます。</li>
        ) : (
          <li>スマホを Mac と同じ Wi-Fi につなぎます。モバイルデータと VPN はオフにします。</li>
        )}
        <li>
          スマホのブラウザー（Android は Chrome、iPhone は Safari）で{" "}
          <code className="font-mono text-foreground" translate="no">
            {check}
          </code>{" "}
          を開きます。Amu の画面が出れば、スマホから Mac まで届いています。もう一度 QR
          コードを読んでください。
        </li>
        <li>
          QR
          コードの読み取りでリンクが別のアプリの中で開いたときは、「ブラウザーで開く」を選びます。
        </li>
        {tailnet ? null : (
          <li>
            2 の住所も開けないときは、Wi-Fi
            の「ゲスト用」や、ルーターの「端末間の通信を制限する」設定（プライバシーセパレーターなど）が原因のことがあります。Wi-Fi
            を変えられないときは、Mac とスマホの両方に Tailscale を入れて、上の「Tailscale
            HTTPS」を使います。外出先からでも、どの端末からでもつながります。
          </li>
        )}
      </ol>
    </details>
  );
}
