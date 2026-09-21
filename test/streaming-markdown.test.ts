import { expect, test } from "bun:test";
import { parser, parser_end, parser_write, Token } from "streaming-markdown";

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
