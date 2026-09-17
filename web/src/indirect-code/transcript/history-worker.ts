/** History normalize worker: parses + normalizes one transcript page
 * off the main thread so receiving a ~128k-token block never freezes
 * the tab. Pure CPU (no DOM/Solid): imports the same
 * normalizeSessionMessages the main thread uses for small snapshots.
 *
 * Protocol: { seq, rawMsgs, indexBase } -> { seq, page }.
 * previous is always [] here: page ids are deterministic (`msg_<srcIdx>`
 * with the daemon's global offset), so the main thread dedupes/merges
 * by id and keeps its own objects (folds, drafts) intact.
 */
import { normalizeSessionMessages } from "./updaters";

export interface HistoryWorkerRequest {
  seq: number;
  rawMsgs: any[];
  indexBase: number;
}

export interface HistoryWorkerResponse {
  seq: number;
  page: ReturnType<typeof normalizeSessionMessages>;
}

self.onmessage = (ev: MessageEvent<HistoryWorkerRequest>) => {
  const { seq, rawMsgs, indexBase } = ev.data || ({} as HistoryWorkerRequest);
  let page: HistoryWorkerResponse["page"];
  try {
    page = normalizeSessionMessages(Array.isArray(rawMsgs) ? rawMsgs : [], [], typeof indexBase === "number" ? indexBase : 0);
  } catch {
    page = [];
  }
  (self as any).postMessage({ seq, page } satisfies HistoryWorkerResponse);
};
