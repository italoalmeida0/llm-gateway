/**
 * Office/PDF/media extraction pipeline, adapted from
 * remote-code-ref/chatbot (utils/fileManager.js + utils/pandoc.js).
 *
 * Everything runs in the browser: magic-bytes sniffing, pdf2md, and
 * pandoc.wasm (lazy, served as a static asset). The daemon only ever
 * receives the extracted text (or image bytes) over the existing
 * upload_attachment channel.
 */

import { filetypeinfo } from "magic-bytes.js";
import pdf2md from "@opendocsg/pdf2md";

export const OFFICE_FORMATS: Record<string, string> = {
  docx: "docx",
  odt: "odt",
  pptx: "pptx",
  xlsx: "xlsx",
  epub: "epub",
  rtf: "rtf",
  rst: "rst",
  ipynb: "ipynb",
};

const BLOCKED_EXTS = new Set([
  "mp4", "avi", "mov", "webm", "mp3", "wav", "flac", "m4a", "ogg",
  "exe", "dll", "bin", "iso", "dmg", "so", "rar", "7z",
]);

const BLOCKED_MIME_PREFIX = ["video/", "audio/"];

export type ExtractKind = "image" | "text" | "office";

export interface ExtractedFile {
  name: string;
  mime: string;
  size: number;
  kind: ExtractKind;
  /** Extracted markdown/text (text + converted office/pdf). */
  text?: string;
  /** Data URL for images. */
  dataUrl?: string;
  /** Raw bytes base64 (for daemon upload of images). */
  bytesB64: string;
  /** True while an async conversion (pdf/office) is still running. */
  loading: boolean;
  loadError?: string;
}

export function uint8ToB64(u8: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function extOf(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** Synchronous sniff: blocked files and office/image/text routing. */
export function sniffFile(
  file: File,
  bytes: Uint8Array,
): { blocked?: string; kind?: ExtractKind; officeFormat?: string } {
  const ext = extOf(file.name);
  let info: Array<{ extension?: string; mime?: string; typename?: string }>;
  try {
    info = filetypeinfo(Array.from(bytes.slice(0, 100))) as any;
  } catch {
    info = [];
  }
  const blocked =
    BLOCKED_EXTS.has(ext) ||
    BLOCKED_MIME_PREFIX.some((m) => (file.type || "").startsWith(m)) ||
    info.some((i) => (i.extension ? BLOCKED_EXTS.has(i.extension) : false));
  if (blocked) {
    return {
      blocked: `The file '${file.name}' is an incompatible binary or media format and has been blocked for safety.`,
    };
  }
  if (OFFICE_FORMATS[ext]) return { kind: "office", officeFormat: OFFICE_FORMATS[ext] };
  const isPdf = ext === "pdf" || info.some((i) => i.typename === "pdf");
  if (isPdf) return { kind: "text", officeFormat: "pdf" };
  const isImage =
    (file.type || "").startsWith("image/") ||
    info.some((i) => (i.mime || "").startsWith("image/"));
  if (isImage) return { kind: "image" };
  return { kind: "text" };
}

/** Extract readable content from raw bytes (pdf/office/text, not images). */
export async function extractText(
  bytes: Uint8Array,
  fileName: string,
  officeFormat?: string,
): Promise<string> {
  if (officeFormat === "pdf") {
    return await pdf2md(bytes as any);
  }
  if (officeFormat) {
    return await convertOfficeToMarkdown(bytes, fileName, officeFormat);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ---- pandoc.wasm (lazy singleton, loaded only for office docs) ----

let pandocInstance: any = null;
let pandocFS: Map<string, any> | null = null;
let PandocFile: any = null;

async function getPandoc(): Promise<{ instance: any; fs: Map<string, any>; File: any }> {
  if (pandocInstance) return { instance: pandocInstance, fs: pandocFS!, File: PandocFile };

  // The 58MB engine ships as a static asset next to the bundle.
  const probe = await fetch("/pandoc.wasm", { method: "HEAD" });
  if (!probe.ok) {
    throw new Error(
      "Office conversion is unavailable (pandoc.wasm not deployed with this gateway build).",
    );
  }
  const shim: any = await import("@bjorn3/browser_wasi_shim");
  const { WASI, OpenFile, File, ConsoleStdout, PreopenDirectory } = shim;

  const args = ["pandoc.wasm", "+RTS", "-H64m", "-RTS"];
  const fds = [
    new OpenFile(new File(new Uint8Array(), { readonly: true })),
    ConsoleStdout.lineBuffered(() => {}),
    ConsoleStdout.lineBuffered(() => {}),
    new PreopenDirectory("/", (pandocFS = new Map())),
  ];
  const wasi = new WASI(args, [], fds, { debug: false });
  const { instance: rawInstance } = await WebAssembly.instantiateStreaming(
    fetch("/pandoc.wasm"),
    { wasi_snapshot_preview1: wasi.wasiImport },
  );
  // pandoc.wasm's exports (malloc/hs_init_with_rtsopts/…) are plain function
  // values — the typed WebAssembly.Exports union has no call signatures.
  const instance = rawInstance as unknown as {
    exports: Record<string, any> & { memory: WebAssembly.Memory };
  };
  wasi.initialize(rawInstance);
  instance.exports.__wasm_call_ctors();

  const view = () => new DataView(instance.exports.memory.buffer);
  const argcPtr = instance.exports.malloc(4);
  view().setUint32(argcPtr, args.length, true);
  const argv = instance.exports.malloc(4 * (args.length + 1));
  for (let i = 0; i < args.length; ++i) {
    const arg = instance.exports.malloc(args[i].length + 1);
    new TextEncoder().encodeInto(
      args[i],
      new Uint8Array(instance.exports.memory.buffer, arg, args[i].length),
    );
    view().setUint8(arg + args[i].length, 0);
    view().setUint32(argv + 4 * i, arg, true);
  }
  view().setUint32(argv + 4 * args.length, 0, true);
  const argvPtr = instance.exports.malloc(4);
  view().setUint32(argvPtr, argv, true);
  instance.exports.hs_init_with_rtsopts(argcPtr, argvPtr);

  pandocInstance = instance;
  PandocFile = File;
  return { instance, fs: pandocFS!, File };
}

export async function convertOfficeToMarkdown(
  bytes: Uint8Array,
  fileName: string,
  inputFormat: string,
): Promise<string> {
  const { instance, fs, File } = await getPandoc();
  const optsStr = JSON.stringify({ from: inputFormat, to: "markdown", "input-files": [fileName] });
  const optsBytes = new TextEncoder().encode(optsStr);
  const optsPtr = instance.exports.malloc(optsBytes.length);
  new Uint8Array(instance.exports.memory.buffer, optsPtr, optsBytes.length).set(optsBytes);

  fs.clear();
  fs.set("stdin", new File(new Uint8Array(), { readonly: true }));
  const outFile = new File(new Uint8Array(), { readonly: false });
  const errFile = new File(new Uint8Array(), { readonly: false });
  fs.set("stdout", outFile);
  fs.set("stderr", errFile);
  fs.set("warnings", new File(new Uint8Array(), { readonly: false }));
  fs.set(fileName, new File(bytes, { readonly: true }));

  instance.exports.convert(optsPtr, optsBytes.length);

  const stdout = new TextDecoder("utf-8", { fatal: false }).decode(outFile.data);
  const stderr = new TextDecoder("utf-8", { fatal: false }).decode(errFile.data);
  if (!stdout && stderr) throw new Error(stderr);
  return stdout;
}
