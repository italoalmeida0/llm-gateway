/**
 * Canonical reasoning effort levels offered by the UI. The daemon accepts
 * these (and more aliases); providers clamp them internally (see
 * remote-code-daemon/packages/provider/reasoning.go). "none" is an explicit
 * off — NormalizeReasoning maps it to the disabled state.
 */
export const REASONING_LEVELS = ["none", "minimum", "low", "medium", "high", "xhigh", "max"] as const;

export const REASONING_LABELS: Record<string, string> = {
  none: "OFF",
  off: "OFF",
  minimum: "MIN",
  min: "MIN",
  low: "LOW",
  medium: "MEDI",
  med: "MEDI",
  medi: "MEDI",
  high: "HIGH",
  xhigh: "XHIGH",
  max: "MAX",
};

function formatEffort(lvl: string): string {
  return REASONING_LABELS[lvl.toLowerCase()] || lvl.toUpperCase();
}

/**
 * Slash command definitions for autocomplete palette.
 * Only commands NOT already configurable somewhere in the UI are listed:
 * model + reasoning effort live in the composer picker,
 * and help + protocols (mcp/skills) live in Settings (sec-* sections).
 */
export const SLASH_COMMANDS = [
  {
    cmd: "/compact",
    desc: "Compact conversation transcript to free up context tokens",
    args: "",
  },
  {
    cmd: "/clear",
    desc: "Start a fresh blank session (history is kept)",
    args: "",
  },
  {
    cmd: "/jail",
    desc: "Strictly confine agent filesystem tools to session directory",
    args: "",
  },
  {
    cmd: "/unjail",
    desc: "Allow agent to access files outside session working directory",
    args: "",
  },
];

/**
 * Tool presentation helpers (Antigravity-style one-line rows).
 * The daemon persists raw call args + results; everything human-readable
 * below is derived locally so transcripts stay exact.
 */
