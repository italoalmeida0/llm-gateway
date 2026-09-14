import type { MCPServerConfig } from "../types";

export function validConfigName(name: string) {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name) &&
    !["constructor", "prototype", "__proto__"].includes(name)
  );
}
export function parseMcpArgs(text: string): string[] {
  if (!text.trim()) return [];
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      'Arguments must be a JSON array, for example ["-y", "package", "/path with spaces"].',
    );
  }
  if (
    !Array.isArray(result) ||
    result.length > 128 ||
    !result.every(
      (v) => typeof v === "string" && v.length <= 16384 && !v.includes("\0"),
    )
  )
    throw new Error(
      "Arguments must be an array of at most 128 strings without null bytes.",
    );
  return result;
}
export function parseMcpVariables(
  text: string,
  headers = false,
): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Variables must be a JSON object of string values.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Variables must be a JSON object of string values.");
  const entries = Object.entries(value);
  if (entries.length > (headers ? 64 : 128))
    throw new Error("Too many variables.");
  for (const [key, val] of entries) {
    const pattern = headers
      ? /^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/
      : /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (
      !pattern.test(key) ||
      key.length > 256 ||
      typeof val !== "string" ||
      val.length > 16384 ||
      (headers ? /[\r\n\0]/ : /\0/).test(val)
    )
      throw new Error("Invalid variable name or value.");
    if (
      headers &&
      [
        "host",
        "content-length",
        "content-type",
        "accept",
        "mcp-session-id",
        "mcp-protocol-version",
      ].includes(key.toLowerCase())
    )
      throw new Error("MCP transport headers are managed automatically.");
  }
  return Object.fromEntries(entries);
}
export function validateMcp(config: MCPServerConfig) {
  if (!config.transport || config.transport === "stdio") {
    if (
      !config.command.trim() ||
      config.command.includes("\0") ||
      config.command.length > 4096
    )
      throw new Error("A valid executable command is required.");
  } else if (["http", "streamable-http", "sse"].includes(config.transport)) {
    let url: URL;
    try {
      url = new URL(config.url || "");
    } catch {
      throw new Error("Enter a valid HTTP or HTTPS server URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (config.url?.length || 0) > 8192
    )
      throw new Error(
        "Use HTTP or HTTPS without embedded credentials or a fragment.",
      );
  } else {
    throw new Error("Unsupported MCP transport.");
  }
}
export function normalizeSkillSelection(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ].slice(0, 128)
    : [];
}
