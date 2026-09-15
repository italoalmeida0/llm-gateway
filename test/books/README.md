# test/books — classic-books corpus (~1.1M tokens)

Local fixture corpus for manual compaction / long-context experiments.
Plain Markdown copies of public-domain classics, sourced from
https://github.com/mlschmitt/classic-books-markdown (no test asserts on
these files — they are raw material for ad-hoc testing).

## Contents (token counts via `tokenx`, same estimator the gateway uses)

| File | Chars | Tokens |
| ---- | ----: | -----: |
| Herman-Melville-Moby-Dick.md | 1,200,152 | 269,720 |
| Fyodor-Dostoyevsky-Crime-and-Punishment.md | 1,142,334 | 262,440 |
| Jane-Austen-Emma.md | 889,921 | 205,346 |
| Bram-Stoker-Dracula.md | 841,880 | 197,010 |
| Oscar-Wilde-The-Picture-of-Dorian-Gray.md | 432,416 | 99,778 |
| Mary-Wollstonecraft-Shelley-Frankenstein.md | 420,400 | 92,360 |
| **Total** | **4,923,088** | **1,126,654** |

Total stays under the 1.2M-token budget.

## Re-counting

```bash
bun -e '
import { estimateTokenCount } from "tokenx";
import { readFileSync, readdirSync } from "fs";
let total = 0;
for (const f of readdirSync("test/books").sort()) {
  if (!f.endsWith(".md") || f === "README.md") continue;
  const tok = estimateTokenCount(readFileSync("test/books/" + f, "utf8"));
  total += tok;
  console.log(String(tok).padStart(7) + "\t" + f);
}
console.log("TOTAL " + total);
'
```

## Refreshing / swapping books

```bash
# the upstream repo is a one-off clone; re-clone if needed:
git clone --depth 1 https://github.com/mlschmitt/classic-books-markdown /tmp/classic-books-markdown
cp "/tmp/classic-books-markdown/<Author>/<Title>.md" "test/books/<Author>-<Title>.md"
# then re-run the count above and update the table
```
