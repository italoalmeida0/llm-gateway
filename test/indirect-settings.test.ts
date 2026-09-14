import { toolSummary } from "../web/src/indirect-code/transcript";
import { describe, expect, test } from "bun:test";
import {
  normalizeSkillSelection,
  parseMcpArgs,
  parseMcpVariables,
  validConfigName,
  validateMcp,
} from "../web/src/indirect-code/utils/settingsValidation";

describe("Indirect Code settings input", () => {
  test("arguments preserve quotes, spaces and literal shell syntax", () => {
    expect(
      parseMcpArgs('["/path with spaces", "a\\"b", "$(literal)"]'),
    ).toEqual(["/path with spaces", 'a"b', "$(literal)"]);
    expect(() => parseMcpArgs("-y package")).toThrow();
    expect(() => parseMcpArgs("[1]")).toThrow();
    expect(() => parseMcpArgs('["\\u0000"]')).toThrow();
  });
  test("secret omission and explicit replacement remain distinct", () => {
    expect(parseMcpVariables("")).toBeUndefined();
    expect(parseMcpVariables("{}")).toEqual({});
    expect(parseMcpVariables('{"TOKEN":"with spaces"}')).toEqual({
      TOKEN: "with spaces",
    });
    expect(() => parseMcpVariables('{"BAD=KEY":"value"}')).toThrow();
    expect(() =>
      parseMcpVariables('{"Authorization":"a\\nb"}', true),
    ).toThrow();
    expect(() =>
      parseMcpVariables('{"Mcp-Session-Id":"override"}', true),
    ).toThrow();
  });
  test("MCP headers separate their short label from the truncatable tool target", () => {
    const summary = toolSummary({
      call: {
        type: "tool_call",
        toolName: "mcp__remote__inspect_item_abcdef012345",
      },
      result: { type: "tool_result", isError: true },
    });
    expect(summary.verb).toBe("MCP");
    expect(summary.target).toBe("remote / inspect_item");
    expect(summary.stat).toBe("Failed");
  });
  test("names, URLs and skill choices reject ambiguous inputs", () => {
    for (const name of [
      "__proto__",
      "constructor",
      "prototype",
      "a/b",
      "",
      "a\nb",
    ])
      expect(validConfigName(name)).toBe(false);
    expect(validConfigName("pr-review.v2")).toBe(true);
    for (const url of [
      "file:///tmp/mcp",
      "https://user:secret@example.com",
      "https://example.com/#fragment",
      "relative",
    ])
      expect(() =>
        validateMcp({ command: "", args: [], transport: "http", url }),
      ).toThrow();
    expect(() =>
      validateMcp({
        command: "",
        args: [],
        transport: "http",
        url: "http://localhost:3030/mcp",
      }),
    ).not.toThrow();
    expect(normalizeSkillSelection([" a ", null, "a", 4, "b", ""])).toEqual([
      "a",
      "b",
    ]);
  });
});
