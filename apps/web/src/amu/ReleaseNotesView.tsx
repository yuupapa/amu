import type { ServerProvider } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { amuLocalPost } from "../lib/lunaAuto";

/**
 * Amu: "詳しくはこちら" in the update notices. Amu's own notes come with the
 * update as Markdown; a CLI's come from its public changelog, translated by
 * Haiku on the server (apps/server/src/luna/CliReleaseNotes.ts).
 */

export type NotesBlock =
  | { kind: "heading"; text: string }
  | { kind: "item"; depth: 0 | 1; text: string }
  | { kind: "text"; text: string };

/** The Markdown Amu's release notes use: headings, bullets one level deep, paragraphs. */
export function parseReleaseNotesMarkdown(markdown: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim()) continue;
    const heading = /^\s*#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1]!.trim() });
      continue;
    }
    const item = /^(\s*)[-*]\s+(.+)$/.exec(line);
    if (item) {
      blocks.push({ kind: "item", depth: item[1]!.length >= 2 ? 1 : 0, text: item[2]!.trim() });
      continue;
    }
    blocks.push({ kind: "text", text: line.trim() });
  }
  return blocks;
}

/** `code` spans and **bold**; everything else stays plain text (no HTML). */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      match[1] !== undefined ? (
        <code key={match.index} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {match[1]}
        </code>
      ) : (
        <strong key={match.index} className="font-medium text-foreground">
          {match[2]}
        </strong>
      ),
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function NotesBlocks({ blocks }: { blocks: ReadonlyArray<NotesBlock> }) {
  return (
    <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
      {blocks.map((block, index) =>
        block.kind === "heading" ? (
          <p key={index} className="pt-1 font-medium text-foreground first:pt-0">
            <Inline text={block.text} />
          </p>
        ) : block.kind === "item" ? (
          <p key={index} className={block.depth === 1 ? "pl-6 -indent-3" : "pl-3 -indent-3"}>
            {"・"}
            <Inline text={block.text} />
          </p>
        ) : (
          <p key={index}>
            <Inline text={block.text} />
          </p>
        ),
      )}
    </div>
  );
}

function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <button
      className="mt-1 cursor-pointer text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
      onClick={() => {
        const bridge = window.desktopBridge;
        if (bridge) void bridge.openExternal(href);
        else window.open(href, "_blank", "noopener,noreferrer");
      }}
      type="button"
    >
      {label}
    </button>
  );
}

/** Amu's own notes for the offered version. */
export function AmuReleaseNotes(props: { text: string; releaseUrl: string | null }) {
  return (
    <div translate="no">
      <NotesBlocks blocks={parseReleaseNotesMarkdown(props.text)} />
      {props.releaseUrl ? <SourceLink href={props.releaseUrl} label="GitHub で見る" /> : null}
    </div>
  );
}

type CliNotes = {
  sections: Array<{ version: string; items: string[] }>;
  language: "ja" | "en";
  sourceUrl: string;
};

type CliNotesRequest = { driver: string; currentVersion: string; latestVersion: string };

/** One request per CLI update, shared by the prefetch and the open panel. */
const cliNotesRequests = new Map<string, Promise<CliNotes | null>>();

function cliNotesRequest(input: CliNotesRequest): Promise<CliNotes | null> {
  const key = `${input.driver}:${input.currentVersion}:${input.latestVersion}`;
  let request = cliNotesRequests.get(key);
  if (!request) {
    request = amuLocalPost("/api/amu/cli-release-notes", input, undefined, {
      notLocal: "このMacのローカルのAmuで利用してください。",
      unknown: "更新内容を取得できませんでした。",
    }).then((answer) => (answer.result ?? null) as CliNotes | null);
    // A failed request may be tried again the next time the panel opens.
    request.catch(() => cliNotesRequests.delete(key));
    cliNotesRequests.set(key, request);
  }
  return request;
}

/** The CLIs in a notice whose installed and offered versions are known. */
export function cliNotesEntries(providers: ReadonlyArray<ServerProvider>): Array<{
  provider: ServerProvider;
  request: CliNotesRequest;
}> {
  return providers.flatMap((provider) => {
    const advisory = provider.versionAdvisory;
    if (!advisory?.currentVersion || !advisory.latestVersion) return [];
    return [
      {
        provider,
        request: {
          driver: provider.driver,
          currentVersion: advisory.currentVersion,
          latestVersion: advisory.latestVersion,
        },
      },
    ];
  });
}

/** Starts fetching (and translating) as soon as the notice shows, so it is ready when opened. */
export function prefetchCliReleaseNotes(providers: ReadonlyArray<ServerProvider>): void {
  for (const { request } of cliNotesEntries(providers))
    void cliNotesRequest(request).catch(() => {});
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; notes: CliNotes | null }
  | { kind: "failed"; message: string };

function OneCliNotes(props: { name: string; request: CliNotesRequest; showName: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const { driver, currentVersion, latestVersion } = props.request;
  useEffect(() => {
    let live = true;
    cliNotesRequest({ driver, currentVersion, latestVersion }).then(
      (notes) => live && setState({ kind: "ready", notes }),
      (error: unknown) =>
        live &&
        setState({
          kind: "failed",
          message: error instanceof Error ? error.message : "更新内容を取得できませんでした。",
        }),
    );
    return () => {
      live = false;
    };
  }, [driver, currentVersion, latestVersion]);

  const title = `${props.name} ${currentVersion} → ${latestVersion}`;
  return (
    <div className="space-y-1">
      {props.showName ? <p className="text-xs font-medium text-foreground">{title}</p> : null}
      {state.kind === "loading" ? (
        <p className="text-xs text-muted-foreground">更新内容を取得し、日本語に訳しています…</p>
      ) : state.kind === "failed" ? (
        <p className="text-xs text-muted-foreground">{state.message}</p>
      ) : !state.notes || state.notes.sections.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          この CLI の更新内容は、Amu からは読み取れません。
        </p>
      ) : (
        <>
          {state.notes.language === "en" ? (
            <p className="text-xs text-muted-foreground">
              日本語に訳せなかったため、英語のまま表示しています。
            </p>
          ) : null}
          <NotesBlocks
            blocks={state.notes.sections.flatMap((section) => [
              { kind: "heading" as const, text: section.version },
              ...section.items.map((text) => ({ kind: "item" as const, depth: 0 as const, text })),
            ])}
          />
          <SourceLink href={state.notes.sourceUrl} label="公式の更新内容を見る" />
        </>
      )}
    </div>
  );
}

/** What each CLI in the notice changes. */
export function CliReleaseNotes(props: { providers: ReadonlyArray<ServerProvider> }) {
  const entries = cliNotesEntries(props.providers);
  if (entries.length === 0)
    return <p className="text-xs text-muted-foreground">更新前後の版がわかりません。</p>;
  return (
    <div className="space-y-3" translate="no">
      {entries.map(({ provider, request }) => (
        <OneCliNotes
          key={provider.instanceId}
          name={provider.displayName ?? provider.driver}
          request={request}
          showName
        />
      ))}
    </div>
  );
}
