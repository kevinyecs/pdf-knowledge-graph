"""PDF reader. Returns pages of text plus a flag for tabular pages,
which the extractor handles differently from prose."""

from dataclasses import dataclass
from typing import List
import pdfplumber


@dataclass
class Page:
    number: int
    text: str
    is_tabular: bool


# Heuristic for "this page is mostly a table". Two signals:
#   - lots of short lines (label + number on one line)
#   - high digit density
def _looks_tabular(text: str) -> bool:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 4:
        return False
    short = sum(1 for ln in lines if len(ln) < 60)
    digit_chars = sum(1 for c in text if c.isdigit())
    digit_ratio = digit_chars / max(1, len(text))
    return (short / len(lines)) > 0.6 and digit_ratio > 0.06


def read_pdf(data: bytes) -> List[Page]:
    pages: List[Page] = []
    with pdfplumber.open(_as_buffer(data)) as pdf:
        for i, p in enumerate(pdf.pages, start=1):
            raw = p.extract_text() or ""
            text = _cleanup(raw)
            pages.append(Page(number=i, text=text, is_tabular=_looks_tabular(text)))
    return pages


def _cleanup(s: str) -> str:
    # join hyphenated line wraps, otherwise leave linebreaks alone,
    # tabular extraction relies on them.
    out = []
    for line in s.splitlines():
        if out and out[-1].endswith("-"):
            out[-1] = out[-1][:-1] + line.lstrip()
        else:
            out.append(line.rstrip())
    return "\n".join(ln for ln in out if ln.strip())


def _as_buffer(data: bytes):
    import io
    return io.BytesIO(data)
