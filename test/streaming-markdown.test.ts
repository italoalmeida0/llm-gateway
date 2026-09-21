import { expect, test } from "bun:test";
import { parser, parser_end, parser_write, Token } from "streaming-markdown";
import { copiedMathFormulas, copiedMathMarkdown, mathFormulas, mathMarkdown } from "./fixtures/markdown-math";

test("inline code requires a complete matching backtick run, including in tables", () => {
  const source = "| Language | Syntax | Result |\n|---|---|---|\n| Python | ` ```python ` | yes |\n| JS | ` ```javascript ` | yes |\n\nDouble ticks: ``a ` b``.\n";
  for (const size of [1, 2, 7, 64, source.length]) {
    const spans: string[] = [];
    const stack: number[] = [];
    let cells = 0;
    const p = parser({ data: null,
      add_token: (_, token) => { stack.push(token); if (token === Token.Code_Inline) spans.push(""); if (token === Token.Table_Cell) cells++; },
      end_token: () => { stack.pop(); },
      add_text: (_, text) => { if (stack.at(-1) === Token.Code_Inline) spans[spans.length - 1] += text; },
      set_attr: () => {},
    });
    for (let i = 0; i < source.length; i += size) parser_write(p, source.slice(i, i + size));
    parser_end(p);
    expect(spans).toEqual(["```python", "```javascript", "a ` b"]);
    expect(cells).toBe(9);
  }
});


function parseMath(source: string, size: number) {
  const equations: { type: number; text: string }[] = [];
  const stack: { type: number; text: string }[] = [];
  let prose = "";
  const p = parser({ data: null,
    add_token: (_, type) => {
      const node = { type, text: "" }; stack.push(node);
      if (type === Token.Equation_Block || type === Token.Equation_Inline) equations.push(node);
    },
    end_token: () => { stack.pop(); },
    add_text: (_, text) => {
      const node = stack.at(-1);
      if (node?.type === Token.Equation_Block || node?.type === Token.Equation_Inline) node.text += text;
      else prose += text;
    },
    set_attr: () => {},
  });
  for (let i = 0; i < source.length; i += size) parser_write(p, source.slice(i, i + size));
  parser_end(p);
  return { equations, prose };
}

test("display math accepts same-line content and trailing opener spaces without consuming prose", () => {
  for (const size of [1, 2, 3, 7, 64, mathMarkdown.length]) {
    const { equations, prose } = parseMath(mathMarkdown, size);
    expect(equations.map((eq) => eq.text.trim())).toEqual(mathFormulas);
    expect(equations.map((eq) => eq.type)).toEqual([
      Token.Equation_Inline, Token.Equation_Inline, Token.Equation_Block,
      Token.Equation_Block, Token.Equation_Block, Token.Equation_Block, Token.Equation_Inline,
    ]);
    expect(prose).toContain("Gaussian integral:");
    expect(prose).toContain("Famous sum:");
    expect(prose).toContain("Matrix product:");
    expect(prose).toContain("Text after math.");
  }
});

test("math preserves escapes and closes only on its own unescaped delimiter", () => {
  const source = String.raw`$\text{\$5} + x$) then \(\text{$} + y\) and \[a \\] b\] end.

Code: ` + '`$x$` and\n\n```tex\n$$x$$\n```\n';
  for (const size of [1, 2, 7, source.length]) {
    const { equations, prose } = parseMath(source, size);
    expect(equations.map((eq) => eq.text)).toEqual([String.raw`\text{\$5} + x`, String.raw`\text{$} + y`, String.raw`a \\] b`]);
    expect(prose).toContain(") then");
    expect(prose).toContain("end.");
    expect(prose).toContain("$$x$$");
  }
});

test("copied math preserves literal underscores and repeated equals signs", () => {
  for (const size of [1, 7, copiedMathMarkdown.length]) {
    const { equations, prose } = parseMath(copiedMathMarkdown, size);
    expect(equations.map((eq) => eq.text.trim())).toEqual(copiedMathFormulas);
    expect(prose).toContain("Text after math.");
  }
});
