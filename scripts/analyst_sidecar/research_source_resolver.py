"""Resolve exact tool-issued research citations across index and archive captures.

Archive projections deliberately use different content-addressed citation IDs
from indexed chunks. Retain only their dated research evidence in a bounded,
process-local registry; account values and live market data are never cached.
An absent or conflicting ID cannot be replaced with a similar publication.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
from datetime import date
import json
import re
import threading


_CITATION_ID = re.compile(r"cite_[a-f0-9]{32}\Z")
_DOCUMENT_ID = re.compile(r"doc_[a-f0-9]{32}\Z")
_FIELDS = {
    "id", "documentId", "product", "publicationDate", "publishedAt", "sourceUri",
    "title", "productLabel", "section", "page", "excerpt", "contentHash",
    "sourceSnapshotId", "sourceSnapshotHash", "sourceContentHash", "sourceMessageId",
    "eventTime", "fieldPath", "sourceEvidence", "sourceQuality", "sourceQualityAnnotation",
}
_IDENTITY_FIELDS = ("documentId", "product", "publicationDate", "sourceUri", "excerpt")
_SOURCE_EVIDENCE_FIELDS = {
    "bodyText", "headline", "summary", "sourceUri", "sourceUrl", "sourceArtifactUri",
    "sourceMessageId", "sourceContentSha256", "contentHash", "publicationDate", "publishedAt",
    "product", "productId", "entityId", "ticker", "fieldPath", "qualityStatus",
}


class ResearchSourceResolver:
    def __init__(self, research_index, *, max_sources=2048, max_bytes=8 * 1024 * 1024):
        self.research_index = research_index
        self.max_sources = max(1, int(max_sources))
        self.max_bytes = max(1, int(max_bytes))
        self._sources = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    @staticmethod
    def _citation(value):
        if not isinstance(value, dict) or not _CITATION_ID.fullmatch(str(value.get("id") or "")):
            return None
        if not _DOCUMENT_ID.fullmatch(str(value.get("documentId") or "")):
            return None
        if any(not isinstance(value.get(key), str) or not value[key].strip()
               for key in ("product", "publicationDate", "sourceUri")):
            return None
        try:
            date.fromisoformat(value["publicationDate"])
        except ValueError:
            return None
        if (not isinstance(value.get("excerpt"), str) or not value["excerpt"].strip()
                or not value["sourceUri"].startswith(("https://", "http://", "s3://", "dynamodb://", "gmail://", "research://"))):
            return None
        # Explicit allowlisting prevents a caller from retaining an enclosing
        # holdings/book/quote envelope in the research registry.
        retained = {key: deepcopy(item) for key, item in value.items() if key in _FIELDS}
        evidence = retained.get("sourceEvidence")
        if isinstance(evidence, dict):
            retained["sourceEvidence"] = {key: deepcopy(item) for key, item in evidence.items() if key in _SOURCE_EVIDENCE_FIELDS}
        elif evidence is not None:
            retained.pop("sourceEvidence")
        try:
            json.dumps(retained, sort_keys=True, allow_nan=False)
        except (TypeError, ValueError):
            return None
        return retained

    def remember(self, citations) -> int:
        """Remember trusted tool-output citations before compacting a capture."""
        remembered = 0
        for value in citations if isinstance(citations, list) else []:
            citation = self._citation(value)
            if citation is None:
                continue
            size = len(json.dumps(citation, ensure_ascii=False, sort_keys=True).encode("utf-8"))
            if size > self.max_bytes:
                continue
            citation_id = citation["id"]
            with self._lock:
                existing = self._sources.get(citation_id)
                if existing is not None:
                    previous, previous_size = existing
                    if previous is None:
                        continue
                    if any(previous.get(key) != citation.get(key) for key in _IDENTITY_FIELDS) or any(
                            previous.get(key) and citation.get(key) and previous[key] != citation[key]
                            for key in ("contentHash", "sourceSnapshotHash", "sourceContentHash")):
                        # Quarantine this ID rather than choosing one source.
                        self._bytes -= previous_size
                        self._sources[citation_id] = (None, 0)
                        continue
                    self._sources.move_to_end(citation_id)
                    remembered += 1
                    continue
                self._sources[citation_id] = (citation, size)
                self._bytes += size
                while len(self._sources) > self.max_sources or self._bytes > self.max_bytes:
                    _key, (_value, removed_size) = self._sources.popitem(last=False)
                    self._bytes -= removed_size
                remembered += 1
        return remembered

    def resolve(self, citation_id):
        """Return an exact index row or its original captured archive evidence."""
        if not isinstance(citation_id, str) or not _CITATION_ID.fullmatch(citation_id):
            return None
        with self._lock:
            retained = self._sources.get(citation_id)
            if retained is not None:
                citation, _size = retained
                if citation is None:
                    return None
                self._sources.move_to_end(citation_id)
                citation = deepcopy(citation)
            else:
                citation = None
        if citation is None:
            return self.research_index.get_source(citation_id)
        return {
            "citation_id": citation["id"], "document_id": citation["documentId"],
            "product": citation["product"], "publication_date": citation["publicationDate"],
            "source_uri": citation["sourceUri"], "title": citation.get("title") or citation["product"],
            "section": citation.get("section"), "page": citation.get("page"), "excerpt": citation["excerpt"],
            "content_hash": citation.get("contentHash") or citation.get("sourceContentHash"),
            "metadata": {"resolutionSource": "captured_research_archive", **{
                key: deepcopy(citation[key]) for key in (
                    "publishedAt", "sourceSnapshotId", "sourceSnapshotHash", "sourceContentHash", "sourceMessageId",
                    "eventTime", "fieldPath", "sourceEvidence", "sourceQuality", "sourceQualityAnnotation") if key in citation}},
            "citation": citation,
        }
