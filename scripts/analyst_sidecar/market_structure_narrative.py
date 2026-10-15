"""Compact, extractive prose from a review's captured Market Structure report.

The caller validates publication eligibility. This module neither looks up newer
research nor derives a market signal, price, or trading instruction. Conditional
passages remain whole so shortening cannot select only one side of a scenario.
"""

import re


_FLOW = re.compile(r"\b(?:systematic|mechanical|CTAs?|vol(?:atility)?[- ]control|rules[- ]based)\b", re.I)
_CONDITIONAL = re.compile(r"\b(?:if|unless|whether|otherwise|conversely)\b", re.I)
_PARTNER = re.compile(r"^(?:Conversely|Otherwise|Alternatively|If\b|Unless\b)", re.I)
_DEPENDENT = re.compile(
    r"^(?:This|That|These|Those|It|They|Such|Again|Overall|Conversely|Otherwise|"
    r"Even so|That said|On the other hand)\b", re.I
)
_LEVEL = re.compile(r"\b(?:support|resistance|bands?|range|upside|downside|gamma|volatility)\b", re.I)
_SENTENCE_END = re.compile(r"[.!?][\"'’”)]*$")
_MAX_WORDS = 230
_FLOW_WORDS = 130


def _words(text):
    return len(text.split())


def _sentences(text):
    # Decimal values are untouched; retain punctuation and never truncate a
    # passage to meet the word budget. The trailing fragment, if any, is omitted.
    return [part for part in re.split(r"(?<=[.!?])\s+(?=[A-Z\"“])", text)
            if _SENTENCE_END.search(part)]


def _passages(snapshot):
    if not isinstance(snapshot, dict):
        return []
    data = snapshot.get("data") if isinstance(snapshot.get("data"), dict) else {}
    blocks = data.get("blocks") if isinstance(data.get("blocks"), list) else []
    texts = [block["text"] for block in blocks if isinstance(block, dict)
             and block.get("type") in {"paragraph", "callout"} and isinstance(block.get("text"), str)]
    if not texts:
        article = snapshot.get("article") if isinstance(snapshot.get("article"), dict) else {}
        body = article.get("bodyText")
        texts = re.split(r"\n\s*\n", body) if isinstance(body, str) else []
    passages, seen = [], set()
    for text in texts:
        text = re.sub(r"\s+", " ", text).strip()
        if not text or text in seen or not _SENTENCE_END.search(text):
            continue
        seen.add(text)
        # Reports can put alternative outcomes in adjacent paragraph blocks.
        # Keep both branches together, including the original condition/negation.
        if passages and _CONDITIONAL.search(passages[-1]) and _PARTNER.search(text):
            passages[-1] += " " + text
        else:
            passages.append(text)
    return passages


def _flow_score(text):
    return (2 * len(_FLOW.findall(text)) + 5 * len(_CONDITIONAL.findall(text))
            + bool(re.search(r"\d", text)))


def _select_flows(passages):
    candidates = [(index, text) for index, text in enumerate(passages) if _FLOW.search(text)]
    chosen, words = [], 0
    for index, text in sorted(candidates, key=lambda item: (-_flow_score(item[1]), item[0])):
        count = _words(text)
        if words + count <= _FLOW_WORDS:
            chosen.append((index, text))
            words += count
    return sorted(chosen)


def _interpretation_candidates(passages):
    candidates = []
    for index, text in enumerate(passages):
        if _FLOW.search(text):
            continue
        candidates.append((index, 0, text, True))
        # An alternative scenario or a qualification is an indivisible passage.
        # Standalone labeled-value sentences may be retained from longer prose.
        if _CONDITIONAL.search(text):
            continue
        sentences = _sentences(text)
        if len(sentences) > 1:
            candidates.extend((index, number + 1, sentence, False)
                              for number, sentence in enumerate(sentences)
                              if not _DEPENDENT.search(sentence))
    return candidates


def _select_interpretation(passages, budget):
    candidates = _interpretation_candidates(passages)
    if not candidates:
        return []
    chosen, covered, words = [], set(), 0

    def take(item):
        nonlocal words
        index, sentence_index, text, whole = item
        if index in covered or any(row[0] == index and (whole or row[3]) for row in chosen):
            return False
        if words + _words(text) > budget:
            return False
        chosen.append(item)
        words += _words(text)
        if whole:
            covered.add(index)
        return True

    # Begin with the source's own opening interpretation when it fits. This
    # keeps the context for later levels without inventing a synthesis sentence.
    first = candidates[0]
    if not take(first):
        for item in candidates:
            if item[0] == first[0] and not item[3] and take(item):
                break

    def score(item):
        text = item[2]
        numeric_level = bool(re.search(r"\d", text) and _LEVEL.search(text))
        return (4 * numeric_level + len(_LEVEL.findall(text)))

    for item in sorted(candidates, key=lambda row: (-score(row), row[0], row[1])):
        if item not in chosen:
            take(item)
    return sorted(chosen, key=lambda item: (item[0], item[1]))


def narrative_blocks(snapshot):
    """Return at most two source-bound, complete-sentence narrative blocks.

    ``text`` includes the display label for existing paragraph renderers; title
    is also supplied for consumers which need it separately. All prose after
    the label is copied from this snapshot, with whitespace normalized only.
    Numeric percentages retain their published meaning and are never recomputed.
    """
    passages = _passages(snapshot)
    flows = _select_flows(passages)
    flow_words = sum(_words(text) for _, text in flows)
    interpretation = _select_interpretation(passages, min(110, _MAX_WORDS - flow_words) if flows else _MAX_WORDS)
    result = []
    for title, text in (("Interpretation", " ".join(row[2] for row in interpretation)),
                        ("Flows to watch", " ".join(row[1] for row in flows))):
        if text:
            result.append({"title": title, "text": f"{title} — {text}"})
    return result
