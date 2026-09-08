import type { ChatMessage } from "../types";
import { REASONING_LABELS } from "../constants";

export function timeAgo(ts: number) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d`;
}

export function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatEffort(lvl: string): string {
  return REASONING_LABELS[lvl.toLowerCase()] || lvl.toUpperCase();
}

export function normalizeEffort(raw: string): string {
  const v = (raw || "").trim().toLowerCase();
  switch (v) {
    case "":
      return "";
    case "no":
    case "false":
    case "disabled":
    case "none":
    case "off":
      return "none";
    case "min":
    case "minimum":
      return "minimum";
    case "low":
      return "low";
    case "med":
    case "medi":
    case "medium":
      return "medium";
    case "hi":
    case "high":
      return "high";
    case "maximum":
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return v;
  }
}

export function messageText(m: ChatMessage): string {
  return m.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("\n");
}
