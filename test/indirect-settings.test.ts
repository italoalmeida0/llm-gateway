import { toolSummary } from "../web/src/indirect-code/transcript";
import { describe, expect, test } from "bun:test";
import { normalizeSkillSelection } from "../web/src/indirect-code/utils/settingsValidation";

describe("Indirect Code settings compatibility", () => {
  test("normalizes skill selections from historical session options", () => {
    expect(normalizeSkillSelection([" a ", null, "a", 4, "b", ""])).toEqual([
      "a",
      "b",
    ]);
    expect(normalizeSkillSelection("review")).toEqual([]);
  });

  test("MCP tool summaries remain readable in historical transcripts", () => {
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
});
