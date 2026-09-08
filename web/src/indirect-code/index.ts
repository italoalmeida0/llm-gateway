/** Barrel for the indirect-code feature: page + public API (types, store, utils). */
export { default } from "./IndirectCodePage";
export { default as IndirectCodePage } from "./IndirectCodePage";
export type {
  AgentSettings, ChatMessage, ContentBlock, MCPServerConfig, PendingApproval,
  PreviewFile, Project, RenderBlock, RenderBlockSeries, SessionSummary,
  SessionUsage, SkillConfig, ToolCat, ToolUnit, MsgPart,
} from "./types";
export { createDataLayer } from "./store/sessions";
export type { RcProject, RcSession } from "./store/sessions";
export { buildRenderBlocks, toolSummary, terminalPresentation, baseNameOf, diffStat } from "./transcript";
export type { ToolSummary } from "./transcript";
export {
  normalizeSessionMessages, mergeUsage, appendTextDelta, appendReasoningDelta,
  upsertToolCall, appendToolArgsDelta, appendToolResult, stampDuration,
  cutTail, mergeAssistantMessage, pushAssistantCarrier, finishTurn,
} from "./transcript/updaters";
export { partitionToolSegs } from "./utils/toolSegs";
export type { ToolSeg } from "./utils/toolSegs";
export { parseDaemonMessage } from "./daemon-protocol";
export type {
  DaemonCommand, DaemonMessage, DaemonEvent, AgentEvent, PullWireMessage,
} from "./daemon-protocol";
