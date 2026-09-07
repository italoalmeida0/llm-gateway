"""Gera web/src/remote-code/viewCtx.ts a partir dos símbolos reais da página."""
import json
import re

ORIG = "web/src/remote-code/RemoteCodePage.tsx"
lines = open(ORIG, encoding="utf-8").read().splitlines(keepends=True)
syms = json.load(open("/tmp/syms.json", encoding="utf-8"))


def balanced(text, start, op, cl):
    depth = 0
    i = start
    while i < len(text):
        if text[i] == "=" and i + 1 < len(text) and text[i + 1] == ">":
            i += 2
            continue
        if text[i] == op:
            depth += 1
        elif text[i] == cl:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    return None


def getter_type(sym):
    decl = lines[syms[sym] - 1].strip()
    m = re.search(r"createSignal<", decl)
    if m:
        t = balanced(decl, m.end() - 1, "<", ">")
        if t:
            return t[1:-1].strip()
    m = re.search(r"createMemo<", decl)
    if m:
        t = balanced(decl, m.end() - 1, "<", ">")
        if t:
            return t[1:-1].strip()
    # inferência de literal inicial
    m = re.search(r"createSignal\(\s*(.*?)\s*\)\s*;?\s*$", decl)
    if m:
        lit = m.group(1).strip()
        if re.match(r"^-?\d+(\.\d+)?$", lit):
            return "number"
        if lit[:1] in ('"', "'", "`"):
            return "string"
        if lit in ("true", "false"):
            return "boolean"
    return "any"


def fn_sig(sym):
    ln = syms[sym]
    buf = lines[ln - 1]
    m = re.search(r"function\s+\w+\s*\(", buf)
    start = buf.index("(", m.start())
    full = buf
    k = ln
    while True:
        seg = full[start:]
        d = 0
        i = 0
        done = False
        end = -1
        while i < len(seg):
            if seg[i] == "=" and i + 1 < len(seg) and seg[i + 1] == ">":
                i += 2
                continue
            if seg[i] == "(":
                d += 1
            elif seg[i] == ")":
                d -= 1
                if d == 0:
                    done = True
                    end = start + i
                    break
            i += 1
        if done or k >= len(lines):
            break
        full += lines[k]
        k += 1
    params = full[start + 1 : end].strip().replace("\n", " ")
    params = re.sub(r"\s+", " ", params)
    # defaults `x = lit` / `x: T = lit` -> `x?: T`
    def conv_default(m):
        name, lit = m.group(1), m.group(2).strip()
        if re.match(r"^-?\d+(\.\d+)?$", lit):
            t = "number"
        elif lit[:1] in ('"', "'", "`"):
            t = "string"
        elif lit in ("true", "false"):
            t = "boolean"
        else:
            t = "any"
        return f"{name}?: {t}"

    def conv_type(lit):
        if re.match(r"^-?\d+(\.\d+)?$", lit):
            return "number"
        if lit[:1] in ('"', "'", "`"):
            return "string"
        if lit in ("true", "false"):
            return "boolean"
        return "any"

    params = re.sub(r"(\w+)(\s*:\s*[^=,)]+)?\s*=\s*([^,)]+)", lambda m: f"{m.group(1)}?: {(m.group(2) or '').strip().lstrip(':').strip() or conv_type(m.group(3).strip())}", params)
    rest = full[end + 1 :]
    rm = re.match(r"\s*(?::\s*([^{\n;]+))?", rest)
    ret = rm.group(1).strip() if rm and rm.group(1) else "any"
    if re.match(r"\s*async\s+function", lines[ln - 1]) and not ret.startswith("Promise"):
        ret = f"Promise<{ret}>" if ret != "void" else "Promise<void>"
    return params, ret


def kind_of(sym, decl):
    d = decl.strip()
    if re.match(r"(const|let)\s+\[\s*" + re.escape(sym) + r"\s*,", d):
        return "getter"
    if re.match(r"(const|let)\s+\[\s*\w+\s*,\s*" + re.escape(sym) + r"\s*\]", d):
        return "setter"
    if re.match(r"(const|let)\s+" + re.escape(sym) + r"\s*=", d):
        return "memo"
    if re.match(r"(async\s+)?function\s+" + re.escape(sym) + r"\b", d):
        return "fn"
    if d.startswith("let " + sym):
        return "ref"
    return "unknown"


MANUAL = {
    "previewPending": "  previewPending: (a: { name: string; mime: string; text?: string; objectUrl?: string; dataB64?: string; size?: number }) => void;",
    "matchQuery": "  matchQuery: (s: SessionSummary) => boolean;",
    "projectSessions": "  projectSessions: (projectId: string) => SessionSummary[];",
    "sortedSessions": "  sortedSessions: (list: SessionSummary[]) => SessionSummary[];",
    "visibleSessions": "  visibleSessions: (key: string, list: SessionSummary[]) => SessionSummary[];",
    "elapsedLabel": "  elapsedLabel: (ms: number) => string;",
    "transcriptScroll": "  transcriptScroll: { schedule: (force?: boolean) => void; measure: () => void; detach: () => void; reset: () => void; dispose: () => void };",
    "wsOpen": "  wsOpen: () => boolean;",
    "activeSession": "  activeSession: () => SessionSummary | null;",
    "verboseChat": "  verboseChat: () => boolean;",
    "renderBlocks": "  renderBlocks: () => RenderBlock[];",
    "visibleBlocks": "  visibleBlocks: () => RenderBlock[];",
    "thinkingIndex": "  thinkingIndex: () => number;",
    "setExpandedThinking": "  setExpandedThinking: (v: Record<string, boolean> | ((p: Record<string, boolean>) => Record<string, boolean>)) => void;",
    "turnClock": "  turnClock: () => number;",
    "toolStarts": "  toolStarts: () => Record<string, number>;",
}

HEADER = """import type {
  AgentSettings, ChatMessage, MCPServerConfig, PendingApproval, PreviewFile,
  Project, RenderBlock, RenderBlockSeries, SessionSummary, SessionUsage,
  SkillConfig, ToolUnit,
} from "./types";
import type { PendingQuestion } from "./components/QuestionModal";
import type { RemoteHostDto, RemotePairDto } from "../api";
import type {
  ChoiceOption, ConfirmState, PendingAttachment, Review, SearchHit,
  StoredAttachment, TodoItem, TurnActivity, WorkspaceStatus,
} from "./viewTypes";

"""


def main():
    allctx = [s for s in open("/tmp/allctx.txt", encoding="utf-8").read().split() if s != "notice"]
    out = """/** Contexto de vista partilhado pelos componentes de layout (sidebar, transcript, composer, onboarding, modais).
 * Gerado por scripts/rc_viewctx.py a partir dos símbolos reais da página. */
export interface RemoteCodeViewCtx {
"""
    for s in sorted(allctx):
        if s in MANUAL:
            out += MANUAL[s] + "\n"
            continue
        ln = syms.get(s)
        if ln is None:
            out += f"  {s}: any;\n"
            continue
        decl = lines[ln - 1].strip()
        k = kind_of(s, decl)
        if k == "getter":
            out += f"  {s}: () => {getter_type(s)};\n"
        elif k == "setter":
            base = s[3:4].lower() + s[4:] if s.startswith("set") else None
            t = getter_type(base) if base and base in syms else "any"
            out += (
                f"  {s}: (v: {t} | ((p: {t}) => {t})) => void;\n"
                if t != "any"
                else f"  {s}: (v: any) => void;\n"
            )
        elif k == "fn":
            params, ret = fn_sig(s)
            out += f"  {s}: ({params}) => {ret};\n"
        elif k == "memo":
            out += f"  {s}: () => {getter_type(s)};\n"
        elif k == "ref":
            m = re.match(r"let\s+\w+\s*:\s*(.+);", decl)
            out += f"  {s}: {m.group(1).strip()};\n" if m else f"  {s}: any;\n"
        else:
            out += f"  {s}: any;\n"
    out += "}\n"
    open("web/src/remote-code/viewCtx.ts", "w", encoding="utf-8").write(HEADER + out)
    print(f"viewCtx: {len(allctx)} campos")


if __name__ == "__main__":
    main()
