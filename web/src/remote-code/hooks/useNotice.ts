import { createSignal, onCleanup } from "solid-js";

export type NoticeKind = "ok" | "err";

/** Toast/notice efémero da página (extraído de RemoteCodePage sem
 * mudança de comportamento). */
export function createNotice() {
  const [appNotice, setAppNotice] = createSignal<{ message: string; kind: NoticeKind } | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(message: string, kind: NoticeKind = "ok") {
    clearTimeout(noticeTimer);
    setAppNotice({ message, kind });
    if (kind === "ok") noticeTimer = setTimeout(() => setAppNotice(null), 5000);
  }
  onCleanup(() => clearTimeout(noticeTimer));
  return { appNotice, setAppNotice, toast };
}

export type Notice = ReturnType<typeof createNotice>;
