import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Responses requires full snapshots at item/response completion. Spill long
 * snapshots to a private temporary file instead of retaining the whole stream.
 * Only serializing a terminal SSE event materializes the complete snapshot. */
export class StreamText {
  private chunks: string[] = [];
  private size = 0;
  private fd: number | undefined;
  private dir: string | undefined;
  append(text: string): void {
    if (!text) return;
    this.size += text.length;
    if (this.fd === undefined && this.size > 64 * 1024) {
      this.dir = mkdtempSync(join(tmpdir(), "llmgw-stream-"));
      this.fd = openSync(join(this.dir, "text"), "w", 0o600);
      for (const chunk of this.chunks) this.write(chunk);
      this.chunks = [];
    }
    if (this.fd === undefined) this.chunks.push(text);
    else this.write(text);
  }
  private write(text: string): void {
    const bytes = Buffer.from(text);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd!, bytes, offset, bytes.length - offset);
  }
  text(): string {
    return this.dir ? readFileSync(join(this.dir, "text"), "utf8") : this.chunks.join("");
  }
  dispose(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = undefined;
    this.chunks = [];
    this.size = 0;
  }
}
