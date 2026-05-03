"""Knowledge graph extractor.

Two pipelines that share a node table and run side by side:

  prose pages  →  spaCy NER + dependency-parsed SVO triples
  tabular pages → regex-based label/amount/date pairing

The two output formats deliberately use the same node/edge schema so the
frontend doesn't care which page produced what.
"""

from __future__ import annotations

import re
from collections import defaultdict, Counter
from dataclasses import dataclass, field, asdict
from typing import Dict, Iterable, List, Optional, Tuple

import spacy
from rapidfuzz import fuzz, process

from pdf_io import Page


# spaCy model is loaded once at import. The small model is enough for what
# we're doing, bigger models change recall but not the shape of the output.
_NLP = spacy.load("en_core_web_sm")


# Entity labels we surface. Anything not in this map gets skipped, which is
# how we filter out spaCy's noisier categories (CARDINAL, ORDINAL, TIME, …).
ENT_KIND = {
    "PERSON":   "person",
    "ORG":      "org",
    "GPE":      "place",
    "LOC":      "place",
    "NORP":     "topic",
    "PRODUCT":  "topic",
    "EVENT":    "topic",
    "WORK_OF_ART": "topic",
    "LAW":      "topic",
    "FAC":      "place",
    "MONEY":    "money",
    "DATE":     "date",
    "PERCENT":  "percent",
    "QUANTITY": "topic",
}

# Verbs we don't want as edge labels. These produce noise edges like
# "Alice be Bob" or "report have figure".
TRIVIAL_VERBS = {
    "be", "have", "do", "say", "see", "go", "make",
    "include", "show", "use", "get",
}


@dataclass
class Node:
    id: str
    label: str
    kind: str
    score: float = 0.0
    mentions: List[int] = field(default_factory=list)


@dataclass
class Edge:
    id: str
    source: str
    target: str
    label: str
    sentence: int
    weight: float = 1.0


@dataclass
class Sentence:
    index: int
    page: int
    text: str


@dataclass
class Graph:
    nodes: List[Node]
    edges: List[Edge]
    sentences: List[Sentence]

    def to_dict(self):
        return {
            "nodes":     [asdict(n) for n in self.nodes],
            "edges":     [asdict(e) for e in self.edges],
            "sentences": [asdict(s) for s in self.sentences],
        }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def extract(pages: List[Page]) -> Graph:
    state = _State()

    for page in pages:
        if page.is_tabular:
            _consume_tabular(state, page)
        else:
            _consume_prose(state, page)

    _merge_aliases(state)
    _score_nodes(state)
    _drop_low_value(state)

    return Graph(
        nodes=list(state.nodes.values()),
        edges=state.edges,
        sentences=state.sentences,
    )


# ---------------------------------------------------------------------------
# Shared mutable state passed through the pipeline
# ---------------------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.nodes: Dict[str, Node] = {}
        self.edges: List[Edge] = []
        self.sentences: List[Sentence] = []
        # remember the canonical id chosen for each (kind, lowercased label)
        # so different surface forms (e.g. "Sample Co." / "Sample Company")
        # collapse onto a single node.
        self.alias_to_id: Dict[Tuple[str, str], str] = {}

    def add_sentence(self, page: int, text: str) -> int:
        idx = len(self.sentences)
        self.sentences.append(Sentence(index=idx, page=page, text=text))
        return idx

    def upsert_node(self, label: str, kind: str, sentence: Optional[int]) -> str:
        label = label.strip()
        if not label:
            return ""
        key = (kind, label.lower())
        if key in self.alias_to_id:
            nid = self.alias_to_id[key]
        else:
            nid = f"{kind}:{label.lower()}"
            self.alias_to_id[key] = nid
            self.nodes[nid] = Node(id=nid, label=label, kind=kind)
        if sentence is not None and sentence not in self.nodes[nid].mentions:
            self.nodes[nid].mentions.append(sentence)
        return nid

    def add_edge(self, src: str, tgt: str, label: str, sentence: int) -> None:
        if not src or not tgt or src == tgt:
            return
        self.edges.append(Edge(
            id=f"e{len(self.edges)}",
            source=src,
            target=tgt,
            label=label,
            sentence=sentence,
        ))


# ---------------------------------------------------------------------------
# Prose pipeline: spaCy NER + SVO via dependency parse
# ---------------------------------------------------------------------------

def _consume_prose(state: _State, page: Page) -> None:
    doc = _NLP(page.text)

    for sent in doc.sents:
        text = sent.text.strip()
        if len(text) < 12:
            continue

        sidx = state.add_sentence(page.number, text)

        # Collect entity nodes from the sentence span.
        ents_in_sent: List[Tuple[str, spacy.tokens.Span]] = []
        for ent in sent.ents:
            kind = ENT_KIND.get(ent.label_)
            if not kind:
                continue
            label = _clean_entity(ent.text)
            if not _entity_is_useful(label, kind):
                continue
            nid = state.upsert_node(label, kind, sidx)
            ents_in_sent.append((nid, ent))

        # Add salient noun chunks too, but only the ones that look like a
        # technical concept (multi-word, not already an entity, not noisy).
        seen_text = {e.text.lower() for _, e in ents_in_sent}
        for chunk in sent.noun_chunks:
            ctext = _clean_entity(chunk.text)
            if (
                ctext.lower() in seen_text
                or len(ctext.split()) < 2
                or len(ctext) > 40
                or _is_pronouny(chunk)
            ):
                continue
            nid = state.upsert_node(ctext, "topic", sidx)
            ents_in_sent.append((nid, chunk))

        # Real edges: SVO from the dependency parse.
        svo_edges = list(_svo_triples(sent))
        used_pairs: set[Tuple[str, str]] = set()

        for subj_span, verb_token, obj_span in svo_edges:
            s_id = _resolve_span_to_node(state, sent, subj_span, sidx)
            o_id = _resolve_span_to_node(state, sent, obj_span, sidx)
            if not s_id or not o_id or s_id == o_id:
                continue
            label = verb_token.lemma_.lower()
            if label in TRIVIAL_VERBS:
                label = f"{verb_token.lemma_.lower()} {_first_prep(verb_token) or ''}".strip()
            state.add_edge(s_id, o_id, label or "related-to", sidx)
            used_pairs.add(_pair_key(s_id, o_id))

        # Backup edges: co-occurrence, but only between *named* entities
        # (person/org/place/money/date/percent). Two raw topics co-occurring
        # in the same sentence is too weak a signal, it carpet-bombs the
        # canvas on prose-heavy documents.
        named_kinds = {"person", "org", "place", "money", "date", "percent"}
        named_ids = [
            nid for nid, _ in ents_in_sent
            if state.nodes[nid].kind in named_kinds
        ]
        for i in range(len(named_ids)):
            for j in range(i + 1, len(named_ids)):
                a, b = named_ids[i], named_ids[j]
                if _pair_key(a, b) in used_pairs:
                    continue
                state.add_edge(a, b, "co-mentioned", sidx)


def _svo_triples(sent: spacy.tokens.Span):
    """Yield (subject_span, verb_token, object_span) for each clause.

    Handles direct objects, prepositional objects ("recombines with holes"),
    and passive voice ("is forward biased"). It's not a full SRL system but
    catches most of what shows up in technical prose.
    """
    for tok in sent:
        if tok.pos_ != "VERB":
            continue

        subj = next((c for c in tok.children if c.dep_ in ("nsubj", "nsubjpass")), None)
        if subj is None:
            continue

        # Direct object
        for c in tok.children:
            if c.dep_ in ("dobj", "attr", "oprd"):
                yield (_expand_chunk(subj), tok, _expand_chunk(c))
            # Prep + pobj  →  use the verb-prep as relation
            if c.dep_ == "prep":
                pobj = next((g for g in c.children if g.dep_ == "pobj"), None)
                if pobj is not None:
                    yield (_expand_chunk(subj), tok, _expand_chunk(pobj))
            # Passive subject: agent (by-phrase)
            if c.dep_ == "agent":
                pobj = next((g for g in c.children if g.dep_ == "pobj"), None)
                if pobj is not None:
                    yield (_expand_chunk(pobj), tok, _expand_chunk(subj))


def _expand_chunk(token):
    """Expand a head token into its noun phrase span."""
    if token.dep_ in ("compound",) and token.head is not None:
        token = token.head
    return token.doc[token.left_edge.i : token.right_edge.i + 1]


def _resolve_span_to_node(state: _State, sent, span, sidx: int) -> str:
    """Find or create a node for a parsed span, preferring named entities
    that overlap it."""
    # 1. Does this span overlap an existing entity?
    for ent in sent.ents:
        if ent.start <= span.start and ent.end >= span.end:
            kind = ENT_KIND.get(ent.label_)
            if kind:
                return state.upsert_node(_clean_entity(ent.text), kind, sidx)

    text = _clean_entity(span.text)
    if not _entity_is_useful(text, "topic"):
        return ""
    if _is_pronouny(span):
        return ""
    return state.upsert_node(text, "topic", sidx)


def _first_prep(verb) -> Optional[str]:
    for c in verb.children:
        if c.dep_ == "prep":
            return c.text.lower()
    return None


# ---------------------------------------------------------------------------
# Tabular pipeline: financial-statement style "label number" lines
# ---------------------------------------------------------------------------

# "$1,265" or "1,265" or "(500)" or "$ 820"
_AMOUNT_RE = re.compile(r"\(?\$?\s*\d[\d,]*(?:\.\d+)?\)?")
_DATE_RE   = re.compile(
    r"(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4}",
    re.IGNORECASE,
)
_HEADING_RE = re.compile(r"^[A-Z][A-Za-z &]{2,}$")


def _consume_tabular(state: _State, page: Page) -> None:
    current_section: Optional[str] = None
    current_company: Optional[str] = None

    for line in page.text.splitlines():
        line = line.strip()
        if not line:
            continue

        sidx = state.add_sentence(page.number, line)

        # Promote a likely company name to a node + remember it as context.
        if _HEADING_RE.match(line) and len(line.split()) <= 5 and "Statement" not in line:
            current_company = line
            state.upsert_node(line, "org", sidx)
            continue

        # Section / statement title
        if line.endswith(":") or _looks_like_statement_title(line):
            current_section = line.rstrip(":")
            state.upsert_node(current_section, "topic", sidx)
            if current_company:
                state.add_edge(
                    state.upsert_node(current_company, "org", sidx),
                    state.upsert_node(current_section, "topic", sidx),
                    "reports",
                    sidx,
                )
            continue

        # Date line
        if (m := _DATE_RE.search(line)):
            d = state.upsert_node(m.group(0), "date", sidx)
            if current_section:
                state.add_edge(
                    state.upsert_node(current_section, "topic", sidx),
                    d, "as-of", sidx,
                )
            continue

        # Label + amount(s)
        amounts = list(_AMOUNT_RE.finditer(line))
        if amounts:
            label = line[:amounts[0].start()].strip(" .:")
            if not label or label.isdigit() or len(label) < 2:
                continue

            # Negative if any amount is parenthesised, financial convention
            metric_id = state.upsert_node(label, "metric", sidx)
            for m in amounts:
                amt = _normalise_amount(m.group(0))
                if amt is None:
                    continue
                amt_id = state.upsert_node(amt, "money", sidx)
                state.add_edge(metric_id, amt_id, "value", sidx)

            # Connect metric to its enclosing section, if any.
            if current_section:
                state.add_edge(
                    state.upsert_node(current_section, "topic", sidx),
                    metric_id, "includes", sidx,
                )


def _looks_like_statement_title(line: str) -> bool:
    return any(line.lower().startswith(p) for p in (
        "income statement", "balance sheet", "statement of",
        "cash flow", "operating expenses", "other item",
    ))


def _normalise_amount(s: str) -> Optional[str]:
    s = s.strip()
    if not s:
        return None
    negative = s.startswith("(") and s.endswith(")")
    digits = re.sub(r"[^0-9.]", "", s)
    if not digits or digits == ".":
        return None
    return f"$({digits})" if negative else f"${digits}"


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def _merge_aliases(state: _State) -> None:
    """Fold near-duplicate nodes within the same kind, e.g. "Sample Co." into
    "Sample Company". rapidfuzz with a high threshold avoids over-merging."""
    by_kind: Dict[str, List[Node]] = defaultdict(list)
    for n in state.nodes.values():
        by_kind[n.kind].append(n)

    rewrite: Dict[str, str] = {}

    for kind, nodes in by_kind.items():
        if kind in ("money", "date", "percent"):
            continue   # don't merge raw values
        for i, n in enumerate(nodes):
            if n.id in rewrite:
                continue
            for j in range(i + 1, len(nodes)):
                other = nodes[j]
                if other.id in rewrite:
                    continue
                if fuzz.token_set_ratio(n.label, other.label) >= 92 and (
                    n.label.lower() in other.label.lower()
                    or other.label.lower() in n.label.lower()
                    or len(n.label) > 4
                ):
                    rewrite[other.id] = n.id
                    n.mentions = sorted(set(n.mentions) | set(other.mentions))

    if not rewrite:
        return

    # Apply rewrites.
    for old, new in rewrite.items():
        state.nodes.pop(old, None)
        # patch the alias map so the merged label keeps resolving
        for key, nid in list(state.alias_to_id.items()):
            if nid == old:
                state.alias_to_id[key] = new

    new_edges: List[Edge] = []
    for e in state.edges:
        s = rewrite.get(e.source, e.source)
        t = rewrite.get(e.target, e.target)
        if s == t:
            continue
        e.source, e.target = s, t
        new_edges.append(e)
    state.edges = _dedupe_edges(new_edges)


def _score_nodes(state: _State) -> None:
    """A simple score: mention count + degree. Used by the frontend search
    to rank ties and by `_drop_low_value` below."""
    deg: Counter = Counter()
    for e in state.edges:
        deg[e.source] += 1
        deg[e.target] += 1
    for n in state.nodes.values():
        n.score = float(len(n.mentions) + deg[n.id] * 0.5)


def _drop_low_value(state: _State) -> None:
    """Drop one-mention isolated nodes, they almost never carry signal and
    they make the canvas look like static."""
    keep = set()
    for e in state.edges:
        keep.add(e.source); keep.add(e.target)
    for nid, n in list(state.nodes.items()):
        if nid in keep:
            continue
        if len(n.mentions) <= 1:
            state.nodes.pop(nid)

    valid = set(state.nodes.keys())
    state.edges = [e for e in state.edges if e.source in valid and e.target in valid]
    state.edges = _dedupe_edges(state.edges)


def _dedupe_edges(edges: List[Edge]) -> List[Edge]:
    """Collapse parallel edges between the same pair, keeping the first
    informative label and counting weight from how many sentences support
    the connection."""
    grouped: Dict[Tuple[str, str], Edge] = {}
    for e in edges:
        k = _pair_key(e.source, e.target)
        if k not in grouped:
            grouped[k] = Edge(
                id=e.id, source=e.source, target=e.target,
                label=e.label, sentence=e.sentence, weight=1.0,
            )
        else:
            existing = grouped[k]
            existing.weight += 1.0
            # Prefer a non-trivial label if we have one.
            if existing.label in ("co-mentioned", "related-to") and e.label not in ("co-mentioned", "related-to"):
                existing.label = e.label
                existing.sentence = e.sentence
    return list(grouped.values())


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _pair_key(a: str, b: str) -> Tuple[str, str]:
    return (a, b) if a < b else (b, a)


_LEADING_ARTICLE = re.compile(r"^(?:the|a|an|this|that|these|those|its|their|his|her|our)\s+", re.IGNORECASE)

def _clean_entity(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    text = text.strip(" .,:;-—()[]")
    text = re.sub(r"\s+'s\b", "", text)
    # Strip leading determiners so "the LED" / "LED" / "an LED" merge.
    text = _LEADING_ARTICLE.sub("", text).strip()
    return text


_PRONOUNS = {
    "he", "she", "it", "they", "we", "you", "i", "him", "her", "them", "us",
    "this", "that", "these", "those", "which", "who",
}

def _is_pronouny(span) -> bool:
    return span.text.strip().lower() in _PRONOUNS


def _entity_is_useful(label: str, kind: str) -> bool:
    if not label or len(label) < 2:
        return False
    if label.lower() in _PRONOUNS:
        return False
    if kind not in ("money", "date", "percent") and not any(c.isalpha() for c in label):
        return False
    return True
