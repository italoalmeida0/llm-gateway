import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { projectForDirectory } from "../paths";
import type { Project, SessionSummary } from "../types";
import type { FoldersEvent, ProjectCreatedEvent, SearchResultsEvent } from "../daemon-protocol";

/** Projects, session list, selection/bulk, rename and search (extracted
 * verbatim from RemoteCodePage — collaborators via params). */
export function createProjects(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getHostId: () => string;
  sessions: () => SessionSummary[];
  projects: () => Project[];
  toast: (message: string, kind?: "ok" | "err") => void;
  showConfirm: (o: { title?: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean }) => Promise<boolean>;
  isHostOnline: () => boolean;
}) {
  const [activeProjectId, setActiveProjectId] = createSignal<string>("");
  const [showNewProjectModal, setShowNewProjectModal] = createSignal(false);
  const [newProjectPath, setNewProjectPath] = createSignal("");
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = createSignal(false);

  const activeProject = createMemo(() => {
    const list = opts.projects();
    if (list.length === 0) return null;
    return list.find((p) => p.id === activeProjectId()) ?? list[0] ?? null;
  });

  // Default project: the one holding the newest conversation (computed from
  // the mirrored data — same answer on every device), else the first one.
  const newestSessionProjectId = createMemo(() => {
    let best: SessionSummary | null = null;
    for (const s of opts.sessions()) {
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    if (!best) return "";
    return projectForDirectory(best.cwd, opts.projects())?.id || "";
  });

  function pickProject(id: string) {
    setActiveProjectId(id);
  }

  // Host folder browser (NewProject modal) + creation.
  const [folderEntries, setFolderEntries] = createSignal<{ name: string; path: string }[]>([]);
  const [folderParent, setFolderParent] = createSignal("");
  const [folderCurrent, setFolderCurrent] = createSignal("");
  const [folderLoading, setFolderLoading] = createSignal(false);
  const [folderError, setFolderError] = createSignal("");
  let folderRequestId = "";
  let projectCreationId = "";
  const [pendingProjectId, setPendingProjectId] = createSignal("");

  function requestFolders(path: string) {
    setNewProjectPath(path);
    if (!opts.isOpen() || !opts.isHostOnline()) { setFolderError("Connect this host to browse its folders."); return; }
    setFolderLoading(true); setFolderError("");
    folderRequestId = crypto.randomUUID();
    opts.send({ type: "browse_folders", path: path || "~", requestId: folderRequestId });
  }
  function openNewProjectModal() {
    setShowNewProjectModal(true);
    requestFolders(activeProject()?.path || "~");
  }
  function createProject() {
    const rawPath = newProjectPath().trim();
    if (!rawPath) {
      opts.toast("Project folder cannot be empty", "err");
      return;
    }
    if (!opts.getHostId()) {
      opts.toast("Connect a host first", "err");
      return;
    }
    if (!opts.isOpen()) {
      // Frontend holds no state of its own — no offline project shadow copies.
      opts.toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    // Daemon is the source of truth; ack arrives as project_created.
    projectCreationId = crypto.randomUUID();
    opts.send({ type: "create_project", path: rawPath, requestId: projectCreationId });
  }
  async function deleteProject(id: string, e: MouseEvent) {
    e.stopPropagation();
    const ok = await opts.showConfirm({
      title: "Delete project?",
      message: "The project AND all of its conversations (transcripts and attached files) are permanently deleted from the host.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    // The daemon cascades (wipes every conversation inside, then pings) —
    // the collections converge on their own; nothing local to purge by hand.
    if (opts.isOpen()) opts.send({ type: "delete_project", projectId: id });
  }
  function quickStartProject() {
    // Quick Start: project rooted at the host home dir + immediate conversation.
    if (!opts.getHostId()) {
      opts.toast("Connect a host first", "err");
      return;
    }
    if (!opts.isOpen()) {
      opts.toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    projectCreationId = crypto.randomUUID();
    opts.send({ type: "create_project", path: "~", requestId: projectCreationId });
  }
  /** folders event (with requestId guard). */
  function noteFolders(msg: FoldersEvent) {
    if (msg.requestId !== folderRequestId) return;
    setFolderLoading(false);
    if (msg.error) { setFolderError(msg.error); return; }
    setFolderEntries(msg.folders || []);
    setFolderParent(msg.parent || "");
    setFolderCurrent(msg.path || "");
    setNewProjectPath(msg.path || "");
  }
  /** requestId guard for the folder browser (page dispatcher). */
  function isFolderRequest(requestId: string | undefined) {
    return requestId === folderRequestId;
  }
  /** requestId guard for create_project (page dispatcher). */
  function isProjectCreation(requestId: string | undefined) {
    return requestId === projectCreationId;
  }
  /** project_created event; returns the project when it matches our ack. */
  function noteProjectCreated(msg: ProjectCreatedEvent): { id: string; name?: string } | null {
    if (msg.requestId !== projectCreationId) return null;
    const p = msg.project;
    if (!p?.id) return null;
    setShowNewProjectModal(false);
    setPendingProjectId(p.id);
    return p;
  }
  function noteProjectError(message: string) {
    setFolderError(message);
  }

  // Nested sidebar state: expanded projects (optimistic overlay + mirrored via SignalDB).
  const [optimisticCollapsed, setOptimisticCollapsed] = createSignal<Record<string, { collapsed: boolean; time: number }>>({});

  function isProjectExpanded(p: { id: string; collapsed?: boolean }) {
    const opt = optimisticCollapsed()[p.id];
    if (opt !== undefined) {
      return !opt.collapsed;
    }
    return !p.collapsed;
  }

  function toggleProjectExpanded(id: string) {
    const p = opts.projects().find((x) => x.id === id);
    const currentlyExpanded = isProjectExpanded(p ?? { id, collapsed: false });
    const nextCollapsed = currentlyExpanded;
    setOptimisticCollapsed((prev) => ({
      ...prev,
      [id]: { collapsed: nextCollapsed, time: Date.now() },
    }));
    if (opts.isOpen()) {
      opts.send({ type: "set_project_collapsed", projectId: id, collapsed: nextCollapsed });
    }
  }

  // Re-confirm with SignalDB response: clear optimistic entry once SignalDB reflects it
  createEffect(() => {
    const projs = opts.projects();
    const opt = optimisticCollapsed();
    const keys = Object.keys(opt);
    if (keys.length === 0) return;

    const now = Date.now();
    let changed = false;
    const next = { ...opt };

    for (const key of keys) {
      const p = projs.find((x) => x.id === key);
      const isRemoteConfirmed = p && (p.collapsed ?? false) === opt[key].collapsed;
      const isExpired = now - opt[key].time > 5000;
      if (isRemoteConfirmed || isExpired) {
        delete next[key];
        changed = true;
      }
    }

    if (changed) {
      setOptimisticCollapsed(next);
    }
  });

  const [expandedSessionLists, setExpandedSessionLists] = createSignal<Record<string, boolean>>({});
  function sortedSessions(list: SessionSummary[]) {
    const arr = [...list];
    arr.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return arr;
  }
  function visibleSessions(key: string, list: SessionSummary[]) {
    if (expandedSessionLists()[key]) return list;
    return sortedSessions([...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10));
  }
  function sessionListToggle(key: string, count: number) {
    return <Show when={count > 10}><button class="px-3 py-2 text-xs text-ink-500 hover:text-ink-200 cursor-pointer" aria-expanded={!!expandedSessionLists()[key]}
      onClick={() => setExpandedSessionLists((prev) => ({ ...prev, [key]: !prev[key] }))}>{expandedSessionLists()[key] ? "Show less" : `See all (${count})`}</button></Show>;
  }
  function sessionsOfProject(projectId: string) {
    return opts.sessions().filter((s) => projectForDirectory(s.cwd, opts.projects())?.id === projectId);
  }
  function projectSessions(projectId: string) {
    return sortedSessions(sessionsOfProject(projectId));
  }
  function looseSessions() {
    return sortedSessions(opts.sessions().filter((s) => !projectForDirectory(s.cwd, opts.projects())));
  }

  // Filter + daemon search (history).
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  function matchQuery(s: SessionSummary) {
    const q = sessionFilter().toLowerCase().trim();
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.model.toLowerCase().includes(q)
    );
  }
  const [searchResults, setSearchResults] = createSignal<import("../viewTypes").SearchHit[]>([]);
  let searchTimer: any = null;
  // Debounced daemon full-text search (transcripts live on the host).
  function queueDaemonSearch(q: string) {
    clearTimeout(searchTimer);
    const query = q.trim();
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimer = setTimeout(() => {
      if (opts.isOpen()) opts.send({ type: "search", query, limit: 30 });
    }, 300);
  }
  function noteSearchResults(msg: SearchResultsEvent) {
    if (typeof msg.query === "string" && msg.query.trim() !== sessionFilter().trim()) return;
    const raw = Array.isArray(msg.results) ? msg.results : [];
    setSearchResults(
      raw.map((r: any) => ({
        sessionId: r.sessionId || "",
        title: r.title || "",
        cwd: r.cwd || "",
        updatedAt: r.updatedAt ?? 0,
        snippet: r.snippet || "",
        matchCount: r.matchCount ?? 0,
      })),
    );
  }

  // Rename inline.
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameText, setRenameText] = createSignal("");
  function submitRename(id: string) {
    const t = renameText().trim();
    if (!t) {
      setRenamingId(null);
      return;
    }
    opts.send({ type: "rename_session", sessionId: id, title: t });
    setRenamingId(null);
  }

  // Selection mode for bulk ops (chatbot thread selection).
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedSessions, setSelectedSessions] = createSignal<Set<string>>(new Set());
  function toggleSessionSelect(id: string) {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedSessions(new Set<string>());
  }
  function togglePin(id: string, e: MouseEvent) {
    e.stopPropagation();
    // Command only — the daemon's change ping brings the new pin state.
    if (opts.isOpen()) opts.send({ type: "toggle_pin", sessionId: id });
  }
  async function pinSelected() {
    const ids = [...selectedSessions()];
    if (ids.length === 0) return;
    const allPinned = ids.every((id) => opts.sessions().find((s) => s.id === id)?.pinned);
    const target = !allPinned;
    for (const id of ids) {
      const cur = opts.sessions().find((s) => s.id === id);
      if (!cur || !!cur.pinned === target) continue;
      if (opts.isOpen()) opts.send({ type: "toggle_pin", sessionId: id });
    }
    opts.toast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} ${target ? "pinned" : "unpinned"}`, "ok");
    exitSelectionMode();
  }
  async function deleteSelected() {
    const ids = [...selectedSessions()];
    if (ids.length === 0) return;
    const ok = await opts.showConfirm({
      title: `Delete ${ids.length} conversation${ids.length === 1 ? "" : "s"}?`,
      message: `This will permanently delete ${ids.length} conversation${ids.length === 1 ? "" : "s"} from the host.\n\nThis action cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    for (const id of ids) opts.send({ type: "delete_session", sessionId: id });
    opts.toast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} deleted`, "ok");
    exitSelectionMode();
  }
  function dropVanishedSession(id: string) {
    if (selectedSessions().has(id)) {
      setSelectedSessions((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return {
    activeProjectId, setActiveProjectId, activeProject, newestSessionProjectId,
    showNewProjectModal, setShowNewProjectModal, newProjectPath, setNewProjectPath,
    projectMenuOpen, setProjectMenuOpen, newProjectMenuOpen, setNewProjectMenuOpen,
    pickProject, openNewProjectModal,
    folderEntries, folderParent, folderCurrent, folderLoading, folderError,
    setFolderLoading, setFolderError,
    requestFolders, createProject, deleteProject, quickStartProject,
    pendingProjectId, setPendingProjectId,
    noteFolders, noteProjectCreated, noteProjectError,
    isFolderRequest, isProjectCreation,
    isProjectExpanded, toggleProjectExpanded,
    sortedSessions, visibleSessions, sessionListToggle,
    sessionsOfProject, projectSessions, looseSessions,
    sessionFilter, setSessionFilter, matchQuery,
    searchResults, setSearchResults, queueDaemonSearch, noteSearchResults,
    renamingId, setRenamingId, renameText, setRenameText, submitRename,
    selectionMode, setSelectionMode, selectedSessions, setSelectedSessions,
    toggleSessionSelect, exitSelectionMode, togglePin, pinSelected, deleteSelected,
    dropVanishedSession,
  };
}

export type Projects = ReturnType<typeof createProjects>;
