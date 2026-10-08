/**
 * Amu: what to try when a phone cannot open the pairing link, under the QR
 * code in Settings → Connections (docs/user/remote-access.md). The first step
 * is the bare address, which shows whether the phone reaches this Mac at all.
 */

/**
 * The address to open first: where the link reaches this Mac, without the
 * pairing token. A hosted-app link (https://app…/pair?host=…) names the Mac
 * in its `host` parameter.
 */
export function reachabilityCheckUrl(pairingUrl: string): string | null {
  try {
    let url = new URL(pairingUrl);
    const host = url.searchParams.get("host");
    if (url.pathname === "/pair" && host) url = new URL(host);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Whether the address is on a tailnet: MagicDNS (*.ts.net) or 100.64.0.0/10. */
export function isTailnetAddress(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith(".ts.net")) return true;
    const parts = host.split(".").map(Number);
    return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
  } catch {
    return false;
  }
}

export function PhoneConnectHelp(props: { pairingUrl: string }) {
  const check = reachabilityCheckUrl(props.pairingUrl);
  if (!check) return null;
  const tailnet = isTailnetAddress(check);
  return (
    <details className="rounded-lg border border-border/50 px-2.5 py-1.5 text-2xs text-muted-foreground">
      <summary className="cursor-pointer text-xs font-medium text-foreground">
        スマホでつながらないとき
      </summary>
      <ol className="mt-1.5 list-decimal space-y-1 pl-4">
        {tailnet ? (
          <li>
            スマホにも Tailscale を入れ、Mac
            と同じアカウントでログインして、接続をオンにしておきます。Wi-Fi
            でもモバイルデータでも構いません。
          </li>
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
