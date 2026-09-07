"""Regras de qualificação ctx. partilhadas por todas as extrações (importar, não duplicar)."""
import re

_HYPHEN_COLON_BEFORE = r"(?<![\w$.:\-])"
_HYPHEN_AFTER = r"(?![\w\-])"


def qualify(body: str, names) -> str:
    """Qualifica símbolos da página como ctx.X apenas em posições de código:
    (a) chamada sym( / acesso sym. sym?. sym! sym[  (b) prop ={sym}  (d) retorno => sym.
    Nunca dentro de data-*, classes, ícones lucide:, strings de texto ou comentários.
    Referências nuas como argumento — filter(matchQuery) — tratam-se manualmente."""
    for s in sorted(names, key=len, reverse=True):
        # (a) chamada/acesso — "(" sempre inicia args (com ou sem conteúdo)
        body = re.sub(
            _HYPHEN_COLON_BEFORE + re.escape(s) + r"(?=\(|[.\?!\[])",
            "ctx." + s,
            body,
        )
        # (a2) spread: ...sym( — o ponto triplo não é acesso a objeto
        body = re.sub(
            r"\.\.\." + re.escape(s) + r"(?=\(|[.\?!\[])",
            "...ctx." + s,
            body,
        )
        # (b) prop ={sym} seguida de } , ) espaço ; /
        body = re.sub(
            r"=\{" + re.escape(s) + r"(?=[},)\s;/])",
            "={ctx." + s,
            body,
        )
        # (d) retorno de arrow: => sym seguido de } , ) ou fim de linha
        body = re.sub(
            r"=>\s*" + re.escape(s) + r"(?=[},)\s;/])",
            "=> ctx." + s,
            body,
        )
    return body


def dedent_min(block: str) -> str:
    ls = block.splitlines(keepends=True)
    ind = [len(l) - len(l.lstrip()) for l in ls if l.strip()]
    m = min(ind) if ind else 0
    return "".join(l[m:] if len(l) - len(l.lstrip()) >= m else l for l in ls)


def dedent2(block: str) -> str:
    return "".join(
        re.sub(r"^  ", "", l, count=1) if l.startswith("  ") else l
        for l in block.splitlines(keepends=True)
    )


def frag(body: str) -> str:
    return "<>\n" + body.rstrip() + "\n</>\n"
