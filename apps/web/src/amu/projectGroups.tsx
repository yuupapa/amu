import { FolderIcon, PlusIcon } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { cn, randomUUID } from "../lib/utils";

/**
 * Amu: groups of projects in the sidebar (docs/user/thread-sidebar.md).
 * Projects whose folders sit in the same parent folder form a group by
 * themselves; groups can also be made, renamed and changed by hand. Picking a
 * group shows the threads of all its projects, through the sidebar's project
 * filter. Hand-made groups are kept in this app's local storage.
 */

export const AMU_GROUP_SCOPE_PREFIX = "amu-group:";
const STORAGE_KEY = "amu:project-groups:v1";

export type ManualProjectGroup = { id: string; name: string; projectKeys: string[] };
export type AmuProjectGroup = {
  /** The sidebar filter value: `amu-group:<id>` or `amu-group:auto:<parent folder>`. */
  scopeKey: string;
  name: string;
  kind: "manual" | "auto";
  projectKeys: string[];
};
type GroupableProject = { projectKey: string; displayName: string; workspaceRoot: string };

function readManualGroups(): ManualProjectGroup[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { id, name, projectKeys } = item as Record<string, unknown>;
      if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(projectKeys))
        return [];
      return [
        {
          id,
          name: name.slice(0, 60),
          projectKeys: projectKeys.filter((key): key is string => typeof key === "string"),
        },
      ];
    });
  } catch {
    return [];
  }
}

let manualGroups: ManualProjectGroup[] | null = null;
const listeners = new Set<() => void>();
const currentManualGroups = () => (manualGroups ??= readManualGroups());

export function saveManualGroups(next: ManualProjectGroup[]): void {
  manualGroups = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

export function useManualProjectGroups(): ManualProjectGroup[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentManualGroups,
    currentManualGroups,
  );
}

/** Folder names that say nothing about the work in them. */
const GENERIC_FOLDERS = new Set(
  [
    "documents",
    "desktop",
    "downloads",
    "projects",
    "repos",
    "src",
    "work",
    "task",
    "tasks",
    "共有ドライブ",
    "マイドライブ",
    "shared drives",
    "my drive",
  ].map((name) => name.toLowerCase()),
);

function isDateLike(name: string): boolean {
  return /^\d{4}-\d{2}(-\d{2})?$/.test(name) || /^\d{8}$/.test(name);
}

/**
 * The folder a project's group is named after: its parent, skipping date
 * folders (Codex's ~/Documents/Codex/2026-10-01/…) and generic ones. Null for
 * a project right in the home folder or at the top of the disk.
 */
export function groupFolderFor(workspaceRoot: string, home: string | null): string | null {
  const parts = workspaceRoot.split("/").filter(Boolean);
  parts.pop();
  while (parts.length > 0) {
    const name = parts.at(-1)!;
    if (!isDateLike(name) && !GENERIC_FOLDERS.has(name.toLowerCase())) break;
    parts.pop();
  }
  const folder = `/${parts.join("/")}`;
  if (parts.length === 0 || (home !== null && (folder === home || home.startsWith(`${folder}/`))))
    return null;
  return folder;
}

export function groupDisplayName(folder: string): string {
  const name = folder.split("/").filter(Boolean).at(-1) ?? folder;
  // Google Drive's own folder carries the account: "GoogleDrive-name@example.com".
  return name.replace(/^GoogleDrive-/, "Google Drive ");
}

/** The user's home, read from the paths themselves (/Users/<name> or /home/<name>). */
export function homeFromPaths(paths: ReadonlyArray<string>): string | null {
  for (const path of paths) {
    const match = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(path);
    if (match) return match[1]!;
  }
  return null;
}

/** Hand-made groups first, then one group per shared parent folder (two or more projects). */
export function buildAmuProjectGroups(
  projects: ReadonlyArray<GroupableProject>,
  manual: ReadonlyArray<ManualProjectGroup>,
): AmuProjectGroup[] {
  const known = new Set(projects.map((project) => project.projectKey));
  const groups: AmuProjectGroup[] = manual.map((group) => ({
    scopeKey: `${AMU_GROUP_SCOPE_PREFIX}${group.id}`,
    name: group.name,
    kind: "manual" as const,
    projectKeys: group.projectKeys.filter((key) => known.has(key)),
  }));
  const placed = new Set(manual.flatMap((group) => group.projectKeys));
  const home = homeFromPaths(projects.map((project) => project.workspaceRoot));
  const byFolder = new Map<string, string[]>();
  for (const project of projects) {
    if (placed.has(project.projectKey)) continue;
    const folder = groupFolderFor(project.workspaceRoot, home);
    if (!folder) continue;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), project.projectKey]);
  }
  for (const [folder, projectKeys] of [...byFolder.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (projectKeys.length < 2) continue;
    groups.push({
      scopeKey: `${AMU_GROUP_SCOPE_PREFIX}auto:${folder}`,
      name: groupDisplayName(folder),
      kind: "auto",
      projectKeys,
    });
  }
  return groups;
}

type Editing = { group: AmuProjectGroup | null };

/** "すべて" and one chip per group, with a button to make one. */
export function AmuProjectGroupBar(props: {
  groups: ReadonlyArray<AmuProjectGroup>;
  projects: ReadonlyArray<GroupableProject>;
  scopeKey: string | null;
  onScopeChange: (scopeKey: string | null) => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  if (props.projects.length < 2 && props.groups.length === 0) return null;
  const chip = (active: boolean) =>
    cn(
      "inline-flex max-w-40 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
      active
        ? "border-primary/40 bg-primary/10 text-foreground"
        : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
    );
  const inGroup = props.scopeKey?.startsWith(AMU_GROUP_SCOPE_PREFIX) ?? false;
  return (
    <div
      className="flex items-center gap-1 overflow-x-auto px-2 pt-1.5 pb-0.5 [scrollbar-width:none]"
      aria-label="プロジェクトのグループ"
      role="toolbar"
    >
      <button
        type="button"
        className={chip(props.scopeKey === null)}
        onClick={() => props.onScopeChange(null)}
      >
        すべて
      </button>
      {props.groups.map((group) => (
        <button
          key={group.scopeKey}
          type="button"
          translate="no"
          title={`${group.name}（${group.projectKeys.length}）${group.kind === "auto" ? "・同じフォルダーから自動" : ""}。右クリックで編集`}
          className={chip(props.scopeKey === group.scopeKey)}
          onClick={() => props.onScopeChange(group.scopeKey)}
          onContextMenu={(event) => {
            event.preventDefault();
            setEditing({ group });
          }}
        >
          <FolderIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{group.name}</span>
        </button>
      ))}
      <button
        type="button"
        className={chip(false)}
        title="グループを作る"
        aria-label="グループを作る"
        onClick={() => setEditing({ group: null })}
      >
        <PlusIcon aria-hidden className="size-3" />
      </button>
      {editing ? (
        <GroupEditor
          group={editing.group}
          projects={props.projects}
          onClose={() => setEditing(null)}
          onSaved={(scopeKey) => {
            setEditing(null);
            if (inGroup || scopeKey) props.onScopeChange(scopeKey);
          }}
        />
      ) : null}
    </div>
  );
}

function GroupEditor(props: {
  group: AmuProjectGroup | null;
  projects: ReadonlyArray<GroupableProject>;
  onClose: () => void;
  onSaved: (scopeKey: string | null) => void;
}) {
  const id = useId();
  const [name, setName] = useState(props.group?.name ?? "");
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(props.group?.projectKeys ?? []),
  );
  const manualId =
    props.group?.kind === "manual"
      ? props.group.scopeKey.slice(AMU_GROUP_SCOPE_PREFIX.length)
      : null;
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || selected.size === 0) return;
    const others = currentManualGroups()
      .filter((group) => group.id !== manualId)
      // A project belongs to one hand-made group at a time.
      .map((group) => ({
        ...group,
        projectKeys: group.projectKeys.filter((key) => !selected.has(key)),
      }))
      .filter((group) => group.projectKeys.length > 0);
    const groupId = manualId ?? randomUUID();
    saveManualGroups([
      ...others,
      { id: groupId, name: trimmed.slice(0, 60), projectKeys: [...selected] },
    ]);
    props.onSaved(`${AMU_GROUP_SCOPE_PREFIX}${groupId}`);
  };
  const remove = () => {
    if (!manualId) return;
    saveManualGroups(currentManualGroups().filter((group) => group.id !== manualId));
    props.onSaved(null);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.group ? "グループを編集" : "グループを作る"}</DialogTitle>
            <DialogDescription>
              {props.group?.kind === "auto"
                ? "同じフォルダーから自動でできたグループです。保存すると、手で作ったグループとして残ります。"
                : "まとめて表示したいプロジェクトを選びます。"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <Input
                id={`${id}-name`}
                aria-label="グループの名前"
                placeholder="グループの名前（例: YouTube）"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto" translate="no">
                {props.projects.map((project) => (
                  <label
                    key={project.projectKey}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent"
                    title={project.workspaceRoot}
                  >
                    <Checkbox
                      checked={selected.has(project.projectKey)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(project.projectKey);
                          else next.delete(project.projectKey);
                          return next;
                        })
                      }
                    />
                    <span className="truncate">{project.displayName}</span>
                  </label>
                ))}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            {manualId ? (
              <Button type="button" variant="ghost" onClick={remove} className="mr-auto">
                グループを解く
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={props.onClose}>
              やめる
            </Button>
            <Button type="submit" disabled={!name.trim() || selected.size === 0}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
