// Same-line display delimiters reproduce the reported integral/sum/matrix failure.
export const mathFormulas = [
  String.raw`E = mc^2`,
  String.raw`\frac{a}{b} + \sqrt{x}`,
  String.raw`\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}`,
  String.raw`\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}`,
  String.raw`\begin{bmatrix}
a & b \\
c & d
\end{bmatrix}
\times
\begin{bmatrix}
x \\
y
\end{bmatrix}
=
\begin{bmatrix}
ax + by \\
cx + dy
\end{bmatrix}`,
  String.raw`\frac{1}{\sqrt{2\pi}}`,
  String.raw`a_1 + b_2`,
];
export const mathMarkdown = `## Inline math

Einstein $${mathFormulas[0]}$ and $${mathFormulas[1]}$.

## Display math

Gaussian integral:

$$ ${mathFormulas[2]} $$

Famous sum:

$$ ${mathFormulas[3]}
$$

Matrix product:

$$  
${mathFormulas[4]}
$$

Bracket notation:

\\[${mathFormulas[5]}\\]

Inline parentheses: \\(${mathFormulas[6]}\\). Text after math.
`;

// Preserve the copied sample's literal escapes and equals signs as authored.
export const copiedMathFormulas = [
  ...mathFormulas.slice(0, 2),
  mathFormulas[2].replace(String.raw`\int_`, String.raw`\int\_`),
  mathFormulas[3].replace(String.raw`\sum_`, String.raw`\sum\_`),
  mathFormulas[4].replace("\n=\n", "\n=============\n"),
];
export const copiedMathMarkdown = '### Code block\n\n```python\n'
  + 'def factorial(n: int) -> int:\n    """Calculate the factorial of n."""\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n\nprint(factorial(5))  # 120\n```\n\n'
  + `### Inline math\n\nEinstein $${copiedMathFormulas[0]}$ and $${copiedMathFormulas[1]}$.\n\n`
  + `### Display math\n\nGaussian integral:\n\n$$ ${copiedMathFormulas[2]} $$\n\n`
  + `Famous sum:\n\n$$ ${copiedMathFormulas[3]} $$\n\n`
  + `Matrix product:\n\n$$\n${copiedMathFormulas[4]}\n$$\n\nText after math.`;
