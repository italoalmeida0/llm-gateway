import { sniffFile, extractText } from "../../office";
import type { DaemonCommand } from "../daemon-protocol";

/**
 * Browser-assisted file conversion (daemon `read` fallback).
 *
 * When the agent's read tool hits a file it cannot parse natively
 * (PDF, docx, odt, epub, rtf, rst, ipynb), the daemon sends a
 * `convert_request` over the relay. This hook runs the SAME pipeline
 * used for attachments (pdf2md / pandoc.wasm in office.ts) and answers
 * with `convert_response`. Failures answer with `error` so the daemon
 * falls back to its plain binary refusal — the turn never hangs.
 */
export function createConvert(opts: {
  send: (payload: DaemonCommand) => void;
}) {
  function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function reply(sessionId: string, requestId: string, text?: string, error?: string) {
    opts.send({ type: "convert_response", sessionId, requestId, text, error });
  }

  /** `convert_request` event. Returns true when consumed. */
  function handleConvertRequest(msg: {
    sessionId?: string;
    requestId: string;
    filename: string;
    data: string;
  }): boolean {
    const sessionId = msg.sessionId || "";
    const requestId = msg.requestId;
    (async () => {
      try {
        const bytes = b64ToBytes(msg.data);
        const sniff = sniffFile({ name: msg.filename } as File, bytes);
        if (sniff.blocked) {
          reply(sessionId, requestId, undefined, sniff.blocked);
          return;
        }
        if (sniff.kind === "image") {
          reply(sessionId, requestId, undefined, "Images are returned natively by the read tool");
          return;
        }
        const text = await extractText(bytes, msg.filename, sniff.officeFormat);
        if (!text || !text.trim()) {
          reply(sessionId, requestId, undefined, "No text extracted");
          return;
        }
        reply(sessionId, requestId, text);
      } catch (err) {
        reply(sessionId, requestId, undefined, err instanceof Error ? err.message : "Conversion failed");
      }
    })();
    return true;
  }

  return { handleConvertRequest };
}

export type Convert = ReturnType<typeof createConvert>;
