/** Barrel do feature remote-code: página + API pública (tipos, store, utils). */
export { default } from "./RemoteCodePage";
export { default as RemoteCodePage } from "./RemoteCodePage";
export type {
  AgentSettings, ChatMessage, ContentBlock, MCPServerConfig, PendingApproval,
  PreviewFile, Project, RenderBlock, RenderBlockSeries, SessionSummary,
  SessionUsage, SkillConfig, ToolCat, ToolUnit, MsgPart,
} from "./types";
export { createDataLayer } from "./store/sessions";
export type { RcProject, RcSession } from "./store/sessions";
export { buildRenderBlocks, toolSummary, terminalPresentation, baseNameOf, diffStat } from "./transcript";
export type { ToolSummary } from "./transcript";
