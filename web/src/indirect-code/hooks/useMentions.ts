import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { DaemonCommand, DaemonEvent } from "../daemon-protocol";
import { activeMention, insertMention } from "../utils/composerTokens";

export function createMentions(opts: {
  send: (command: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  getProjectId: () => string;
  text: () => string;
  setText: (text: string) => void;
  inputId: string;
}) {
  const [caret, setCaret] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  const [dismissed, setDismissed] = createSignal("");
  const [files, setFiles] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [index, setIndex] = createSignal(0);
  const token = createMemo(() =>
    focused() ? activeMention(opts.text(), caret()) : null,
  );
  const key = createMemo(() => JSON.stringify(token()));
  const open = () => !!token() && key() !== dismissed();
  let requestId = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const current = token(),
      sid = opts.getSessionId(),
      project = opts.getProjectId(),
      connected = opts.isOpen();
    key();
    clearTimeout(timer);
    requestId = "";
    setFiles([]);
    setIndex(0);
    setError("");
    setLoading(false);
    if (!current) return;
    if (!connected) {
      setError("Reconnect the host to search files");
      return;
    }
    setLoading(true);
    timer = setTimeout(() => {
      requestId = crypto.randomUUID();
      opts.send({
        type: "search_files",
        requestId,
        sessionId: sid,
        projectId: project,
        query: current.query,
      });
      timer = setTimeout(() => {
        requestId = "";
        setLoading(false);
        setError("File search timed out. Type to retry.");
      }, 10000);
    }, 180);
  });
  onCleanup(() => clearTimeout(timer));
  function noteMatches(msg: Extract<DaemonEvent, { type: "file_matches" }>) {
    if (msg.requestId !== requestId || !requestId) return;
    clearTimeout(timer);
    requestId = "";
    setLoading(false);
    setFiles(msg.files || []);
    setError(msg.error || "");
  }
  function pick(path: string) {
    const current = token();
    if (!current) return;
    const next = insertMention(opts.text(), current, path);
    opts.setText(next.text);
    setCaret(next.caret);
    queueMicrotask(() => {
      const input = document.getElementById(
        opts.inputId,
      ) as HTMLTextAreaElement | null;
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  }
  function keyDown(e: KeyboardEvent) {
    if (e.isComposing || !open()) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(key());
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) =>
        Math.max(
          0,
          Math.min(files().length - 1, i + (e.key === "ArrowDown" ? 1 : -1)),
        ),
      );
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      if (!files().length) return false;
      e.preventDefault();
      const file = files()[index()];
      if (file) pick(file);
      return true;
    }
    return false;
  }
  function begin() {
    const input = document.getElementById(
      opts.inputId,
    ) as HTMLTextAreaElement | null;
    const start = input?.selectionStart ?? opts.text().length,
      end = input?.selectionEnd ?? start;
    const prefix = opts.text().slice(0, start),
      insert = `${prefix && !/\s$/.test(prefix) ? " " : ""}@`;
    opts.setText(prefix + insert + opts.text().slice(end));
    setCaret(start + insert.length);
    setFocused(true);
    setDismissed("");
    queueMicrotask(() => {
      input?.focus();
      input?.setSelectionRange(caret(), caret());
    });
  }
  return {
    open,
    files,
    loading,
    error,
    index,
    pick,
    keyDown,
    begin,
    noteMatches,
    setCaret,
    setFocused,
    focused,
  };
}
