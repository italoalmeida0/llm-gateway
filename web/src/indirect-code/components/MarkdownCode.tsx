import type { JSX } from "solid-js";
import { Icon } from "../../components/icon";
import { fileIcon, hasFileIcon } from "../files";

/**
 * Streamdown `code` override for the chat transcript: inline code that names
 * a file with a known icon (e.g. `server.ts`, `src/api/routes.ts`,
 * `Dockerfile`) renders with the file icon on its left. Anything else —
 * identifiers, commands, prose with dots — renders as plain <code>,
 * byte-identical to the streamdown default. Fenced code blocks are untouched.
 */

function codeText(children: unknown): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    let out = "";
    for (const c of children) {
      const t = codeText(c);
      if (t === null) return null;
      out += t;
    }
    return out;
  }
  return null;
}

export function FileInlineCode(props: any): JSX.Element {
  const node = props?.node as { position?: { start?: { line?: number }; end?: { line?: number } } } | undefined;
  const startLine = node?.position?.start?.line;
  const endLine = node?.position?.end?.line;
  const inline = startLine === undefined || endLine === undefined || startLine === endLine;
  const text = codeText(props?.children);
  if (!inline || text === null || !hasFileIcon(text)) {
    // Default streamdown inline rendering (same classes + data attribute).
    return (
      <code class={`rounded bg-muted px-1.5 py-0.5 font-mono text-sm ${props?.className ?? ""}`} data-streamdown="inline-code">
        {props?.children}
      </code>
    );
  }
  const name = text.trim().split(/[\\/]/).pop() || text.trim();
  const spec = fileIcon(name);
  return (
    <code class={`rounded bg-muted px-1.5 py-0.5 font-mono text-sm ${props?.className ?? ""}`} data-streamdown="inline-code" data-file={name}>
      <Icon icon={spec.icon} size={12} class={spec.class} />
      {props?.children}
    </code>
  );
}

/** Shared Streamdown components override for transcript markdown. */
export const transcriptMarkdownComponents = { code: FileInlineCode };
