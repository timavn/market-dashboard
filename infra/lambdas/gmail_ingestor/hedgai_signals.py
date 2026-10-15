"""Bounded HedgAI email evidence, separate from directional Trade and Trend."""
from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo


PRODUCT = "hedgai-signals"
PARSER_VERSION = "hedgai-email-v2"
NY = ZoneInfo("America/New_York")
CATEGORIES = {
    "buys added": "open-long",
    "shorts added": "open-short",
    "buys closed": "close-long",
    "shorts closed": "close-short",
}
PUBLICATION_SUBJECT = re.compile(r"^(?:\[CORRECTION\]\s*)?HedgAI\s+Signals\s*(?:\||:|[–—-])\s*\S", re.I)
MARKETING_SUBJECT = re.compile(
    r"\b(?:welcome|webinar|introducing|subscribe|subscription|trial|discount)\b|"
    r"\b(?:special offer|exclusive invitation|live demo|you.re invited|get started)\b", re.I
)
PUBLICATION_TIME = re.compile(
    r"\b(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2})\s*([AP]M)\s+(EDT|EST|ET)\b", re.I
)
HEADING = re.compile(r"^\s*(Buys Added|Shorts Added|Buys Closed|Shorts Closed)\s*:\s*(.*?)\s*$", re.I)
EMPTY = re.compile(r"^(?:none|none today|no changes?|n/?a|nil|[-–—])\.?$", re.I)


class _ActionListParser(HTMLParser):
    """Keep action values inside their source list item, including empty items."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.parts = []
        self.sections = []

    def handle_starttag(self, tag, attrs):
        if tag == "li":
            if self.depth == 0:
                self.parts = []
            self.depth += 1
        elif self.depth and tag == "br":
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag != "li" or not self.depth:
            return
        self.depth -= 1
        if not self.depth:
            line = re.sub(r"\s+", " ", "".join(self.parts)).strip()
            match = HEADING.match(line)
            if match:
                self.sections.append((match, True))

    def handle_data(self, data):
        if self.depth:
            self.parts.append(data)


def _action_sections(html_body, text):
    parser = _ActionListParser()
    parser.feed(html_body)
    # A matched list item has a known source boundary. A blank textual heading
    # alone does not, and must remain unresolved instead of swallowing a footer.
    if parser.sections:
        return parser.sections
    return [(match, False) for line in text.splitlines() if (match := HEADING.match(line))]


def is_publication_subject(subject):
    value = re.sub(r"\s+", " ", str(subject or "")).strip()
    return bool(PUBLICATION_SUBJECT.search(value) and not MARKETING_SUBJECT.search(value))


def is_nonpublication_subject(subject):
    value = str(subject or "")
    # Unknown report layouts remain archived as unsupported evidence. Only
    # positively identified welcome/marketing mail is skipped before fetch.
    return bool(re.search(r"\bhedgai\b", value, re.I) and MARKETING_SUBJECT.search(value))


def _label(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def instrument_for_label(value):
    catalog = json.loads(Path(__file__).with_name("hedgai_instruments.json").read_text())
    matching = [row for row in catalog["instruments"] if _label(value) in {
        _label(row.get("sourceLabel")), _label(row.get("ticker")),
        *(_label(alias) for alias in row.get("aliases", [])),
    }]
    return matching[0] if len(matching) == 1 else None


def _issue(code, source_text, publication_id, **fields):
    identity = f"{publication_id}|{code}|{source_text}"
    return {"id": hashlib.sha256(identity.encode()).hexdigest(), "code": code,
            "message": source_text, "sourceText": source_text, "field": "hedgai",
            "affectedFields": ["hedgai"], **fields}


def parse_publication(*, html_body, text, subject, received_at, message_id, s3_key):
    """Read only explicit action headings and headline reaffirmations.

    Performance promotion, footer ticker lists and PDF-only fields remain in
    archived article evidence. None are extrapolated into the publisher book.
    """
    if not is_publication_subject(subject):
        return None
    headings = _action_sections(html_body, text)
    explicit_no_changes = bool(re.search(r"(?im)^\s*(?:there are )?no (?:signal )?changes(?: today)?[.!]?\s*$", text))
    if not headings and not explicit_no_changes:
        return None

    canonical = re.search(r"https://app\.hedgeye\.com/feed_items/(\d+)", html.unescape(html_body))
    source_url = canonical.group(0) if canonical else f"https://mail.google.com/mail/u/0/#all/{message_id}"
    publication_id = f"hedgai:{canonical.group(1)}" if canonical else f"hedgai:gmail:{message_id}"
    issues = []
    stamp = PUBLICATION_TIME.search(text)
    publication_basis = "email-received-at"
    published = received_at.astimezone(timezone.utc)
    if stamp:
        try:
            parsed = datetime.strptime(" ".join(stamp.groups()[:3]), "%m/%d/%Y %I:%M %p")
            published = parsed.replace(tzinfo=NY).astimezone(timezone.utc)
            publication_basis = "visible-publication-time"
        except ValueError:
            issues.append(_issue("HEDGAI_PUBLICATION_TIME_INVALID", stamp.group(0), publication_id))
    else:
        issues.append(_issue("HEDGAI_PUBLICATION_TIME_MISSING", "Visible publication time unavailable", publication_id))
    published_at = published.isoformat()
    publication_date = published.astimezone(NY).date().isoformat()
    common = {"publicationId": publication_id, "publishedAt": published_at,
              "publicationDate": publication_date, "sourceUrl": source_url}
    actions = []
    categories = set()
    for match, bounded in headings:
        category = match.group(1).lower()
        categories.add(category)
        raw = match.group(2).strip()
        if bounded and not raw:
            continue
        if EMPTY.fullmatch(raw):
            continue
        if not raw:
            issues.append(_issue("HEDGAI_EMPTY_ACTION_CATEGORY", match.group(0), publication_id))
            continue
        for source_label in re.split(r"\s*[,;]\s*", raw):
            source_label = source_label.strip().rstrip(".")
            row = instrument_for_label(source_label)
            source_text = f"{match.group(1)}: {source_label}"
            if not row:
                issues.append(_issue("HEDGAI_INSTRUMENT_UNMAPPED", source_text, publication_id,
                                     sourceLabel=source_label))
                continue
            actions.append({**common, "instrumentId": row["instrumentId"],
                            "ticker": row["ticker"], "sourceLabel": source_label,
                            "action": CATEGORIES[category], "sourceCategory": match.group(1),
                            "sourceText": source_text})
    if headings and categories != set(CATEGORIES):
        issues.append(_issue("HEDGAI_ACTION_CATEGORIES_INCOMPLETE",
                             "Missing categories: " + ", ".join(sorted(set(CATEGORIES) - categories)), publication_id))
    # Duplicate repeated source blocks are one action, while opposite actions
    # survive for the projector to validate as a publication-level transition.
    actions = list({(row["instrumentId"], row["action"]): row for row in actions}.values())
    reaffirmations = []
    for clause in re.split(r"[;|]", subject):
        match = re.match(r"\s*(?:Remaining|Remain|Staying|Still)\s+(Long|Short)\s+([A-Za-z0-9./-]+)\b", clause, re.I)
        if not match:
            continue
        row = instrument_for_label(match.group(2))
        if row:
            reaffirmations.append({**common, "instrumentId": row["instrumentId"],
                                   "ticker": row["ticker"], "sourceLabel": match.group(2),
                                   "action": f"maintain-{match.group(1).lower()}",
                                   "sourceText": clause.strip()})
    quality = {"status": "discrepancy" if issues else "clear", "issues": issues}
    complete = not any(issue["code"] in {
        "HEDGAI_INSTRUMENT_UNMAPPED", "HEDGAI_ACTION_CATEGORIES_INCOMPLETE", "HEDGAI_EMPTY_ACTION_CATEGORY",
    } for issue in issues)
    publication = {**common, "sourceMessageId": message_id, "sourceArtifact": s3_key,
                   "headline": subject, "actionCount": len(actions), "complete": complete,
                   "sourceQuality": quality, "publicationTimeBasis": publication_basis}
    return {"date": publication_date, "publishedAt": published_at,
            "publicationId": publication_id, "sourceUrl": source_url,
            "parserVersion": PARSER_VERSION, "sourceQuality": quality,
            "itemCount": len(actions), "decisionEligible": False,
            "data": {"publication": publication, "actions": actions,
                     "reaffirmations": reaffirmations, "metricsPublications": [],
                     "complete": complete, "signalLayer": "hedgai"}}
