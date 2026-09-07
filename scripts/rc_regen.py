"""Regeneração total dos ficheiros extraídos de web/src/pages/RemoteCode.tsx.

Uso: bun run ... | python3 scripts/rc_regen.py  (ou: python3 scripts/rc_regen.py)
Lê o original + listas de símbolos e reescreve todos os componentes/modals/utils.
Idempotente: correr N vezes dá o mesmo resultado.
"""
import json
import re
import sys

sys.path.insert(0, "scripts")
from rc_qualify import dedent2, dedent_min, frag, qualify

ORIG = "web/src/pages/RemoteCode.tsx"
lines = open(ORIG, encoding="utf-8").read().splitlines(keepends=True)


def rng(a, b):
    return "".join(lines[a - 1 : b])


def used(*groups):
    out = set()
    for g in groups:
        out.update(open(f"/tmp/used_{g}.txt", encoding="utf-8").read().split())
    out.add("copyMsg")
    out.discard("notice")  # parâmetro de render-prop, nunca foi símbolo da página
    return out


_INTERNAL = {"renderAssistantSpecial", "renderMessageContent", "renderSeriesLead", "renderImageBlock", "sessionRow"}
LAYOUT_NAMES = used("Sidebar", "Transcript", "Composer", "Onboarding") - _INTERNAL


def write(path, content):
    open(path, "w", encoding="utf-8").write(content)
    print(f"{path}: {len(content.splitlines())}L")


# ---------------- Onboarding (4436-4563) ----------------
write(
    "web/src/remote-code/components/Onboarding.tsx",
    """import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import type { RemoteCodeViewCtx } from "../viewCtx";

export function Onboarding(ctx: RemoteCodeViewCtx) {
  return (
"""
    + frag(qualify(dedent_min(rng(4436, 4563)), LAYOUT_NAMES))
    + "  );\n}\n",
)

# ---------------- WorkspaceSidebar (4569-4832) ----------------
sb = dedent_min(rng(4569, 4832)).replace("sessionRow(", "SessionRow(ctx, ")
sb = qualify(sb, LAYOUT_NAMES)
write(
    "web/src/remote-code/components/WorkspaceSidebar.tsx",
    """import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { ThemeToggle } from "../../ui";
import type { RemoteCodeViewCtx } from "../viewCtx";
import { SessionRow } from "./SessionSidebar";
import { FloatMenu } from "./FloatMenu";

export function WorkspaceSidebar(ctx: RemoteCodeViewCtx) {
  return (
"""
    + frag(sb)
    + "  );\n}\n",
)

# ---------------- TranscriptView (4836-5319, sem <main>) ----------------
raw_tr = dedent_min(rng(4836, 5319))
raw_tr = (
    raw_tr.replace("renderAssistantSpecial(", "renderAssistantSpecial(ctx, ")
    .replace("renderMessageContent(", "renderMessageContent(ctx, ")
    .replace("renderSeriesLead(", "renderSeriesLead(ctx, ")
    .replace("filter(matchQuery)", "filter(ctx.matchQuery)")
)
tr = qualify(raw_tr, LAYOUT_NAMES)
tr = tr.replace("ctx.timeAgo(", "timeAgo(")
write(
    "web/src/remote-code/components/TranscriptView.tsx",
    """import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import { QuestionPanel } from "./QuestionModal";
import { Streamdown } from "streamdown-solid";
import { FileIcon } from "../presentation";
import { tryParseArgs } from "../utils/tools";
import { timeAgo } from "../utils/format";
import type { RemoteCodeViewCtx } from "../viewCtx";
import {
  renderAssistantSpecial, renderImageBlock, renderMessageContent, renderSeriesLead,
} from "./TranscriptBlocks";

export function TranscriptView(ctx: RemoteCodeViewCtx) {
  return (
"""
    + frag(tr)
    + "  );\n}\n",
)

# ---------------- Composer (5320-5908) ----------------
cp = qualify(dedent_min(rng(5320, 5908)), LAYOUT_NAMES)
cp = cp.replace("ctx.contextDisplay(", "contextDisplay(").replace(
    "filter(matchQuery)", "filter(ctx.matchQuery)"
)
write(
    "web/src/remote-code/components/Composer.tsx",
    """import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Tooltip } from "../../ui";
import { compactTokens, contextDisplay } from "../context";
import { formatEffort } from "../utils/format";
import { baseNameOf } from "../transcript";
import type { RemoteCodeViewCtx } from "../viewCtx";
import { CodeBlock } from "./CodeBlock";
import { FloatMenu } from "./FloatMenu";
import { QuestionPanel } from "./QuestionModal";
import { FileIcon } from "../presentation";

export function Composer(ctx: RemoteCodeViewCtx) {
  return (
"""
    + frag(cp)
    + "  );\n}\n",
)

# ---------------- CodeBlock (596-766) ----------------
write(
    "web/src/remote-code/components/CodeBlock.tsx",
    """import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode, languageForPath } from "../utils/lang";

"""
    + rng(596, 766),
)

# ---------------- SessionSidebar (SessionStopButton 4281-4318 + sessionRow 4322-4421) ----------------
sb2 = """import { createSignal, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { timeAgo } from "../utils/format";
import type { SessionSummary } from "../types";

export function SessionStopButton(props: {
  sessionId: string;
  isCancelling: boolean;
  onCancel: (e: MouseEvent | KeyboardEvent) => void;
}) {
""" + dedent2(rng(4281, 4318)) + "}\n\n"
sb2 += """/** Linha de sessão da sidebar (row completa com rename inline + hover actions). */
export interface SessionRowCtx {
  activeSessionId: () => string | null;
  selectedSessions: () => Set<string>;
  selectionMode: () => boolean;
  renamingId: () => string | null;
  renameText: () => string;
  setRenameText: (v: string) => void;
  setRenamingId: (v: string | null) => void;
  submitRename: (id: string) => void;
  toggleSessionSelect: (id: string) => void;
  selectSession: (id: string) => void;
  setHistoryView: (v: boolean) => void;
  closeSidebarOnMobile: () => void;
  togglePin: (id: string, e: MouseEvent) => void;
  deleteSession: (id: string, e: MouseEvent) => void;
  sessionStatus: () => string;
  turnActivity: () => { status: string } | null;
  cancelTurnForSession: (id: string, e: MouseEvent | KeyboardEvent) => void;
}

export function SessionRow(ctx: SessionRowCtx, s: SessionSummary) {
"""
rowbody = dedent2(rng(4322, 4421)) + "}\n"
for n in [
    "activeSessionId", "selectedSessions", "selectionMode", "renamingId",
    "renameText", "setRenameText", "setRenamingId", "submitRename",
    "toggleSessionSelect", "selectSession", "setHistoryView",
    "closeSidebarOnMobile", "togglePin", "deleteSession", "sessionStatus",
    "turnActivity", "cancelTurnForSession",
]:
    rowbody = re.sub(r"(?<![\w$.:\-])" + n + r"(?![\w\-])", "ctx." + n, rowbody)
sb2 += rowbody
write("web/src/remote-code/components/SessionSidebar.tsx", sb2)

print("layout/components OK")

# ---------------- SimpleModals (NewProject 5913-5929, Review 5930-5950, Choice 6084-6103, Confirm 6105-6112, Pair 6115-6181) ----------------
MODAL_NAMES = [
    "showNewProjectModal", "setShowNewProjectModal", "newProjectPath",
    "folderCurrent", "folderParent", "folderEntries", "folderLoading",
    "folderError", "requestFolders", "reviewOpen", "setReviewOpen",
    "reviewLoading", "reviewError", "taskReview", "sessionStatus", "wsOpen",
    "undoChanges", "keepChanges", "createProject", "setNewProjectPath",
    "choiceState", "confirmState", "setConfirmState",
    "showPairModal", "setShowPairModal", "pairingData",
]


def qmodal(body):
    return qualify(body, MODAL_NAMES)


simple_head = """import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { languageForPath } from "../utils/lang";
import type { ChoiceOption, ConfirmState } from "../viewTypes";
import { FileIcon } from "../presentation";
import { CodeBlock, DiffView } from "../components/CodeBlock";
import { copyWithToast } from "../../ui";
import type { Review } from "../viewTypes";

"""
simple_iface = """/** Props partilhadas dos modais simples (getters + ações vindos da página). */
export interface SimpleModalsCtx {
  showNewProjectModal: () => boolean;
  setShowNewProjectModal: (v: boolean) => void;
  newProjectPath: () => string;
  folderCurrent: () => string | null;
  folderParent: () => string;
  folderEntries: () => Array<{ name: string; path: string }>;
  createProject: () => void;
  setNewProjectPath: (v: string) => void;
  folderLoading: () => boolean;
  folderError: () => string | null;
  requestFolders: (path: string) => void;
  reviewOpen: () => boolean;
  setReviewOpen: (v: boolean) => void;
  reviewLoading: () => boolean;
  reviewError: () => string | null;
  taskReview: () => Review | null;
  sessionStatus: () => string;
  wsOpen: () => boolean;
  undoChanges: (path?: string) => Promise<void>;
  keepChanges: () => void;
  choiceState: () => { title: string; message: string; options: ChoiceOption[]; resolve: (id: string | null) => void } | null;
  confirmState: () => ConfirmState | null;
  setConfirmState: (v: null) => void;
  showPairModal: () => boolean;
  setShowPairModal: (v: boolean) => void;
  pairingData: () => { token: string; expiresAt: number; connectUrl: string } | null;
}

"""
sm = simple_head + simple_iface
sm += "export function NewProjectModal(ctx: SimpleModalsCtx) {\n  return (\n" + frag(qmodal(dedent_min(rng(5913, 5929)))) + "  );\n}\n\n"
sm += "export function ReviewModal(ctx: SimpleModalsCtx) {\n  return (\n" + frag(qmodal(dedent_min(rng(5930, 5950)))) + "  );\n}\n\n"
sm += "export function ChoiceModal(ctx: SimpleModalsCtx) {\n  return (\n" + frag(qmodal(dedent_min(rng(6084, 6103)))) + "  );\n}\n\n"
sm += "export function ConfirmModal(ctx: SimpleModalsCtx) {\n  return (\n" + frag(qmodal(dedent_min(rng(6105, 6112)))) + "  );\n}\n\n"
sm += "export function PairModal(ctx: SimpleModalsCtx) {\n  return (\n" + frag(qmodal(dedent_min(rng(6115, 6181)))) + "  );\n}\n"
# keepChanges é closure do ReviewModal original? verificar: rng 5930-5950 usa keepChanges?
write("web/src/remote-code/modals/SimpleModals.tsx", sm)

# ---------------- PreviewModal (5951-6081) ----------------
pv_head = """import { For, Show } from "solid-js";
import { Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { languageForPath } from "../utils/lang";
import { CodeBlock } from "../components/CodeBlock";
import { copyWithToast } from "../../ui";

export interface PreviewModalCtx {
  previewFile: () => import("../types").PreviewFile | null;
  setPreviewFile: (v: null) => void;
  previewCopied: () => boolean;
  setPreviewCopied: (v: boolean) => void;
  downloadPreviewFile: () => void;
  restorePreviewFile: () => void;
  truncatePreviewFile: () => void;
  showTruncateInput: () => boolean;
  setShowTruncateInput: (v: boolean) => void;
  truncateTokens: () => number;
  setTruncateTokens: (v: number) => void;
}

export function PreviewModal(ctx: PreviewModalCtx) {
  return (
"""
pv_names = [
    "previewFile", "setPreviewFile", "previewCopied", "setPreviewCopied",
    "downloadPreviewFile", "restorePreviewFile", "truncatePreviewFile",
    "showTruncateInput", "setShowTruncateInput", "truncateTokens",
    "setTruncateTokens",
]
pvb = qualify(dedent_min(rng(5951, 6081)), pv_names)
write("web/src/remote-code/modals/PreviewModal.tsx", pv_head + frag(pvb) + "  );\n}\n")

# ---------------- Settings (General 6196-6350, Mcp 6351-6458, Skills 6459-6571, shell 6182-6195) ----------------
SETTINGS_NAMES = [
    "showConfigModal", "setShowConfigModal", "cancelSettings", "saveDaemonConfig",
    "toast", "appNotice", "convWidth", "setConvWidth", "daemonSettings",
    "setDaemonSettings", "verboseChat", "setVerboseChat", "mcpServers",
    "newMcpName", "setNewMcpName", "newMcpCmd", "setNewMcpCmd", "newMcpArgs",
    "setNewMcpArgs", "newMcpUrl", "setNewMcpUrl", "newMcpTransport",
    "setNewMcpTransport", "handleAddMcpServer", "handleDeleteMcpServer",
    "newSkillName", "setNewSkillName", "newSkillDesc", "setNewSkillDesc",
    "newSkillBody", "setNewSkillBody", "handleAddSkill", "handleDeleteSkill",
    "toggleSkill", "skills",
]


def qsettings(body):
    return qualify(body, SETTINGS_NAMES)


settings_head = """import { For, Show } from "solid-js";
import { Modal, Btn, ThemeToggle } from "../../ui";
import { Icon as Iconify } from "../../components/icon";

"""
settings_iface = """export interface SettingsModalCtx {
  showConfigModal: () => boolean;
  setShowConfigModal: (v: boolean) => void;
  cancelSettings: () => void;
  saveDaemonConfig: () => boolean;
  toast: (msg: string, kind?: string) => void;
  appNotice: () => { kind: string; message: string } | null;
  convWidth: () => string;
  setConvWidth: (v: string) => void;
  daemonSettings: () => Record<string, any>;
  setDaemonSettings: (v: Record<string, any> | ((p: Record<string, any>) => Record<string, any>)) => void;
  verboseChat: () => boolean;
  setVerboseChat: (v: boolean) => void;
  mcpServers: () => Record<string, { command?: string; args?: string[]; url?: string; transport?: string }>;
  newMcpName: () => string; setNewMcpName: (v: string) => void;
  newMcpCmd: () => string; setNewMcpCmd: (v: string) => void;
  newMcpArgs: () => string; setNewMcpArgs: (v: string) => void;
  newMcpUrl: () => string; setNewMcpUrl: (v: string) => void;
  newMcpTransport: () => string; setNewMcpTransport: (v: string) => void;
  handleAddMcpServer: () => void;
  handleDeleteMcpServer: (name: string) => void;
  newSkillName: () => string; setNewSkillName: (v: string) => void;
  newSkillDesc: () => string; setNewSkillDesc: (v: string) => void;
  newSkillBody: () => string; setNewSkillBody: (v: string) => void;
  handleAddSkill: () => void;
  handleDeleteSkill: (name: string) => void;
  toggleSkill: (name: string) => void;
  skills: () => Array<{ name: string; description: string; enabled: boolean }>;
}

"""
write(
    "web/src/remote-code/modals/SettingsGeneral.tsx",
    settings_head + settings_iface
    + "export function SettingsGeneralSection(ctx: SettingsModalCtx) {\n  return (\n"
    + frag(qsettings(dedent_min(rng(6195, 6348)))) + "  );\n}\n",
)
write(
    "web/src/remote-code/modals/SettingsMcp.tsx",
    settings_head + 'import type { SettingsModalCtx } from "./SettingsModal";\n\n'
    + "export function SettingsMcpSection(ctx: SettingsModalCtx) {\n  return (\n"
    + frag(qsettings(dedent_min(rng(6350, 6456)))) + "  );\n}\n",
)
write(
    "web/src/remote-code/modals/SettingsSkills.tsx",
    settings_head + 'import type { SettingsModalCtx } from "./SettingsModal";\n\n'
    + "export function SettingsSkillsSection(ctx: SettingsModalCtx) {\n  return (\n"
    + frag(qsettings(dedent_min(rng(6458, 6569)))) + "  );\n}\n",
)
shell = (
    settings_head + settings_iface
    + 'import { SettingsGeneralSection } from "./SettingsGeneral";\n'
    + 'import { SettingsMcpSection } from "./SettingsMcp";\n'
    + 'import { SettingsSkillsSection } from "./SettingsSkills";\n\n'
    + "export function SettingsModal(ctx: SettingsModalCtx) {\n  return (\n"
    + frag(
        qsettings(dedent_min(rng(6182, 6194)))
        + "        <SettingsGeneralSection {...ctx} />\n"
        + "        <SettingsMcpSection {...ctx} />\n"
        + "        <SettingsSkillsSection {...ctx} />\n"
        + qsettings(dedent_min(rng(6571, 6572)))
    )
    + "  );\n}\n"
)
write("web/src/remote-code/modals/SettingsModal.tsx", shell)
print("modals OK")
