import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createBackground } from "../../web/src/indirect-code/hooks/useBackground";
import { BackgroundCard } from "../../web/src/indirect-code/components/BackgroundCard";
import { ToolBody } from "../../web/src/indirect-code/components/tool/ToolBody";
import { ToolUnitHeader } from "../../web/src/indirect-code/components/tool/ToolUnitHeader";
import { useToolUnitModel } from "../../web/src/indirect-code/components/tool/toolUnitModel";
import { BackgroundCtx, UICtx } from "../../web/src/indirect-code/ctx";

const sent: unknown[] = [];
(window as any).__sent = sent;
const [sessionId] = createSignal("s1");
const bg = createBackground({
  send: (p) => sent.push(p),
  isOpen: () => true,
  getSessionId: () => sessionId(),
  toast: () => {},
});
const uiStub = { convWidthClass: () => "max-w-3xl" } as any;

const [toolProgress] = createSignal<Record<string, string>>({});
const [toolStarts] = createSignal<Record<string, number>>({});
const [turnClock] = createSignal(Date.now());
const renderCtx: any = {
  renderBlocks: () => [],
  sessionStatus: () => "idle",
  messages: () => [],
  thinkingStart: () => null,
  thinkingElapsed: () => 0,
  toolProgress,
  elapsedLabel: (ms: number) => `${Math.round(ms / 1000)}s`,
  specialProgress: () => undefined,
  thinkingIndex: () => 0,
  verboseChat: () => true,
  hideToolMessages: () => false,
  setPreviewFile: () => {},
  turnClock,
  toolStarts,
  activeSession: () => null,
  pendingApproval: () => null,
  projects: () => [],
  backgroundJobs: () => bg.sessionJobs(),
  bgOutput: () => bg.output(),
  bgClock: () => bg.clock(),
};

const facts = (...labels: string[]) => labels.map((label) => ({ label, tone: "muted" as const }));

function ToolRow(props: { unit: any }) {
  const m = useToolUnitModel(renderCtx, "msg1", props.unit, 0, () => false, () => false);
  return (
    <div class="border border-line/60 rounded-lg overflow-hidden mb-3 bg-card" data-audit-row={props.unit.call.toolName}>
      <ToolUnitHeader ctx={renderCtx} msgId="msg1" u={props.unit} m={m} running={false} active={false} />
      <div class="border-t border-line/40">
        <ToolBody ctx={renderCtx} msgId="msg1" u={props.unit} m={m} running={false} active={false} />
      </div>
    </div>
  );
}

const units: any[] = [
  {
    // A legitimate bracketed last line is output, not a footer.
    call: { toolId: "bash0", toolName: "bash", toolArgs: JSON.stringify({ command: "deploy.sh" }) },
    result: {
      toolResult: "uploading assets...\ndone [done]\n\n[exit 0]",
      toolDetails: { env: { exit: "0", command: "deploy.sh" }, footer: facts("exit 0") },
    },
  },
  {
    // Literal "N:" prefixes in arbitrary output are NOT line numbers: no gutter.
    call: { toolId: "bash0b", toolName: "bash", toolArgs: JSON.stringify({ command: "cat /tmp/train.log" }) },
    result: {
      toolResult: "1:epoch 1/10 loss 2.41\n2:epoch 2/10 loss 1.87\n3:epoch 3/10 loss 1.32",
      toolDetails: { env: { exit: "0", command: "cat /tmp/train.log" }, footer: facts("exit 0") },
    },
  },
  {
    call: { toolId: "bash1", toolName: "bash", toolArgs: JSON.stringify({ command: "git log --oneline -20 -- web/src/indirect-code/components" }) },
    result: {
      toolResult: "02e46d6 feat(web): plain-text tool output and integrated background logs\n76a6b5b fix(web): keep pipe tables literal in basic thinking mode\ne6affd8 fix(web): keep bracketed text literal in basic thinking mode\n924b8de feat(web): basic markdown mode for model thinking\n45add8f feat(web): render thinking text as plain text\ncdb52f5 fix(web): stop underscore markdown from treating identifiers as emphasis\n\n[exit 0]  [6 lines]",
      toolDetails: { env: { exit: "0", command: "git log --oneline -20 -- web/src/indirect-code/components" }, footer: facts("exit 0", "6 lines") },
    },
  },
  {
    call: { toolId: "bash2", toolName: "bash", toolArgs: JSON.stringify({ command: "grep -rn 'TODO' web/src | head -50" }) },
    result: {
      toolResult: "web/src/indirect-code/components/tool/ToolSearchBodies.tsx:118:            // TODO: structured view for the common case\nweb/src/indirect-code/hooks/useBackground.ts:142:      // TODO: merge live tail into the snapshot on the daemon side",
      toolDetails: { env: { exit: "1", command: "grep -rn 'TODO' web/src | head -50" }, footer: facts("exit 1", "2 lines", "0.2s") },
    },
  },
  {
    call: { toolId: "py1", toolName: "python", toolArgs: JSON.stringify({ code: "import json\nfrom collections import Counter\n\nwith open('runners/out/summary.json') as f:\n    data = json.load(f)\n\ncounts = Counter(entry['status'] for entry in data['jobs'])\nprint(dict(counts))\nprint('total', sum(counts.values()))" }) },
    result: {
      toolResult: "{'done': 12, 'running': 2, 'error': 1}\ntotal 15",
      toolDetails: { env: { exit: "0" }, footer: facts("exit 0", "2 lines", "0.6s") },
    },
  },
  {
    call: { toolId: "read1", toolName: "read", toolArgs: JSON.stringify({ path: "web/src/indirect-code/components/BackgroundCard.tsx", offset: 1, limit: 12 }) },
    result: {
      toolResult: "1:import { For, Show, createEffect, createMemo, createSignal, on } from \"solid-js\";\n2:import { useBackground, useUI } from \"../ctx\";\n3:import type { SessionBgTask } from \"../hooks/useBackground\";\n4:import { elapsedLabel } from \"../utils/format\";\n5:import { Icon as Iconify } from \"../../components/icon\";\n6:import { CodeBlock, ShellCmd } from \"./CodeBlock\";\n7:\n8:/** Middle-truncated one-line command for the card row. */\n9:function shortLabel(cmd: string, max = 64) {\n10:  const one = cmd.replace(/\\s+/g, \" \").trim();\n11:  if (one.length <= max) return one;\n12:  const head = Math.ceil((max - 3) / 2);",
      toolDetails: { env: { path: "web/src/indirect-code/components/BackgroundCard.tsx", lines: "12" }, footer: facts("lines 1–12 of 178") },
    },
  },
  {
    call: { toolId: "write1", toolName: "write", toolArgs: JSON.stringify({ path: "/tmp/audit.txt", content: "line one\nline two\nline three" }) },
    result: {
      toolResult: "1:line one\n2:line two\n3:line three",
      toolDetails: { env: { path: "/tmp/audit.txt" }, footer: facts("3 lines written") },
    },
  },
  {
    call: { toolId: "edit1", toolName: "edit", toolArgs: JSON.stringify({ path: "web/src/indirect-code/components/tool/ToolSearchBodies.tsx", oldText: "old", newText: "new" }) },
    result: {
      toolResult: "118:            // TODO: structured view for the common case\n119:            <CodeBlock plain wrap={false} />",
      toolDetails: { env: { path: "web/src/indirect-code/components/tool/ToolSearchBodies.tsx" }, footer: facts("1 hunk applied") },
    },
  },
  {
    call: { toolId: "search1", toolName: "search", toolArgs: JSON.stringify({ pattern: "bodyWithoutFooter", path: "web/src" }) },
    result: {
      toolResult: "web/src/indirect-code/utils/envelope.ts:60:export function bodyWithoutFooter(text: string, footer: string | undefined): string {\nweb/src/indirect-code/components/tool/toolUnitModel.ts:41:const output = () => bodyWithoutFooter(u.result?.toolResult || \"\", (u.result?.toolDetails as any)?.footer);",
      toolDetails: { env: { pattern: "bodyWithoutFooter", path: "web/src" }, footer: facts("2 matches in 2 files") },
    },
  },
  {
    call: { toolId: "glob1", toolName: "glob", toolArgs: JSON.stringify({ pattern: "web/src/indirect-code/components/tool/*" }) },
    result: {
      toolResult: "web/src/indirect-code/components/tool/ToolEditBodies.tsx\nweb/src/indirect-code/components/tool/ToolQuestionBodies.tsx\nweb/src/indirect-code/components/tool/ToolSearchBodies.tsx\nweb/src/indirect-code/components/tool/ToolUnitHeader.tsx\nweb/src/indirect-code/components/tool/toolUnitModel.ts",
      toolDetails: { env: { pattern: "web/src/indirect-code/components/tool/*" }, footer: facts("5 files") },
    },
  },
  {
    call: { toolId: "inspect1", toolName: "inspect", toolArgs: JSON.stringify({ path: "web/src/indirect-code/components/tool" }) },
    result: {
      toolResult: "web/src/indirect-code/components/tool/\n├── ToolEditBodies.tsx (5.1 KB, 171 lines)\n├── ToolQuestionBodies.tsx (2.8 KB, 94 lines)\n├── ToolSearchBodies.tsx (8.2 KB, 253 lines)\n├── ToolUnitHeader.tsx (2.3 KB, 76 lines)\n└── toolUnitModel.ts (4.4 KB, 139 lines)",
      toolDetails: { env: { path: "web/src/indirect-code/components/tool" }, footer: facts("5 entries") },
    },
  },
  {
    call: { toolId: "bgcheck1", toolName: "bg_check", toolArgs: JSON.stringify({ job_id: "bg_1", offset: 1, limit: 50 }) },
    result: {
      toolResult: "1:epoch 1/10 loss 2.41\n2:epoch 2/10 loss 1.87\n3:epoch 3/10 loss 1.32\n4:epoch 4/10 loss 0.98\n5:epoch 5/10 loss 0.71",
      toolDetails: { env: { kind: "python", status: "running", command: "train.py", page: "1-5/12", next: "6", info: "No output yet." }, footer: facts("running", "page 1-5/12", "more lines: offset 6", "No output yet.") },
    },
  },
  {
    call: { toolId: "bgcancel1", toolName: "bg_cancel", toolArgs: JSON.stringify({ job_id: "bg_2" }) },
    result: {
      toolResult: "Cancellation requested for bg_2.",
      toolDetails: { env: { job_id: "bg_2" }, footer: facts() },
    },
  },
  {
    call: { toolId: "sleep1", toolName: "sleep", toolArgs: JSON.stringify({ seconds: 42 }) },
    result: undefined,
  },
];

render(() => (
  <UICtx.Provider value={uiStub}>
    <BackgroundCtx.Provider value={bg as any}>
      <main class="px-4 py-6 max-w-3xl mx-auto">
        <h1 class="text-sm font-semibold text-ink-100 mb-3">Tool body audit</h1>
        {units.map((u) => <ToolRow unit={u} />)}
        <BackgroundCard contextKey="s1" />
      </main>
    </BackgroundCtx.Provider>
  </UICtx.Provider>
), document.getElementById("root")!);

bg.noteSessionTasks([
  { id: "bg_1", kind: "python", label: "python train.py --epochs 10", status: "running", startedAt: Date.now() - 45_000, content: "epoch 1/10 loss 2.41\nepoch 2/10 loss 1.87\nepoch 3/10 loss 1.32\nepoch 4/10 loss 0.98\nepoch 5/10 loss 0.71\n" },
  { id: "bg_2", kind: "bash", label: "bun run build:daemon:all", status: "done", startedAt: Date.now() - 300_000, endedAt: Date.now() - 120_000, exitCode: 0, content: "[build] linux/amd64\n[build] linux/arm64\n[build] darwin/amd64\n[build] OK -> indirect-code-daemon/dist\n" },
  { id: "bg_3", kind: "bash", label: "go test ./...", status: "error", startedAt: Date.now() - 600_000, endedAt: Date.now() - 500_000, exitCode: 2, content: "--- FAIL: TestRunnerRecovery (0.42s)\n    runner_recovery_test.go:88: unexpected state\nFAIL\n" },
] as any);
Object.assign(window, { auditReady: true });
