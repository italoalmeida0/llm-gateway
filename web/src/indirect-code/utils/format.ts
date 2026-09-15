import type { ChatMessage } from "../types";
import { REASONING_LABELS } from "../constants";

export function timeAgo(ts: number) {
  // Zero/missing timestamps used to render as "20706d" (epoch vs now).
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d`;
}

export function formatDurationSecs(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds)) return "—";
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    const parts = [`${h}h`];
    if (m > 0) parts.push(`${m}m`);
    if (s > 0) parts.push(`${s}s`);
    return parts.join(" ");
  }
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function elapsedLabel(ms: number) {
  if (!Number.isFinite(ms)) return "—";
  return formatDurationSecs(Math.floor(ms / 1000));
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

import { stripLeadingSystemPrompt } from "../live";

export function messageText(m: ChatMessage): string {
  const raw = m.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("\n");
  return m.role === "user" ? stripLeadingSystemPrompt(raw) : raw;
}
