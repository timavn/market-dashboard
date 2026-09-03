"""Rebuildable SQLite FTS5 + local-embedding index for The Analyst."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import struct
import threading
from typing import Any, Iterable, Optional, Protocol, Sequence

from contracts import Citation, make_citation_id, stable_id, utc_now_iso


MODEL_NAME = "BAAI/bge-small-en-v1.5"
PARSER_VERSION = "analyst-normalizer-v1"
MAX_EXCERPT_CHARS = 1_500
DEFAULT_RESULT_LIMIT = 8
MAX_RESULT_LIMIT = 20
MAX_RESULT_TEXT_CHARS = 18_000
PAGE_GRANT_TTL_MINUTES = 15
EMBEDDING_BATCH_SIZE = max(1, min(64, int(os.environ.get("ANALYST_EMBEDDING_BATCH_SIZE", "32"))))


def default_data_dir() -> Path:
    configured = os.environ.get("ANALYST_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path.home()
        / "Library"
        / "Application Support"
        / "market-dashboard"
        / "analyst"
    )


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    text = text.replace("\x00", " ")
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[\t\f\v ]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def content_hash(text: str) -> str:
    return sha256(normalize_text(text).encode("utf-8")).hexdigest()


def chunk_text(text: str, *, target_chars: int = 1_200, overlap_chars: int = 160) -> list[str]:
    normalized = normalize_text(text)
    if not normalized:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", normalized) if part.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(paragraph) > target_chars * 2:
            sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        else:
            sentences = [paragraph]
        for sentence in sentences:
            candidate = f"{current}\n\n{sentence}".strip() if current else sentence
            if current and len(candidate) > target_chars:
                chunks.append(current)
                tail = current[-overlap_chars:].lstrip()
                current = f"{tail} {sentence}".strip()
            else:
                current = candidate
    if current:
        chunks.append(current)
    return chunks


def extract_symbols(text: str) -> list[str]:
    candidates = re.findall(r"(?<![A-Za-z0-9])\$?([A-Z][A-Z0-9.\-]{0,7})(?![A-Za-z0-9])", text)
    stop = {
        "A", "AN", "AND", "AS", "AT", "BE", "BY", "CPI", "ET", "ETF", "FOR", "FROM",
        "GDP", "I", "IN", "IS", "IT", "LLM", "MCP", "NO", "NOT", "OF", "ON", "OR",
        "PDF", "THE", "TO", "US", "USD", "WITH", "YES",
    }
    return sorted({candidate for candidate in candidates if candidate not in stop})[:100]


class Embedder(Protocol):
    model_name: str

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class FastEmbedder:
    model_name = MODEL_NAME

    def __init__(self) -> None:
        self._model = None
        self._model_lock = threading.Lock()
        # FastEmbed's ONNX session can otherwise be entered concurrently by a
        # foreground search and the background indexer. Besides oversubscribing
        # CPU, that can make the sidecar unresponsive long enough for the stack
        # supervisor to restart it. Keep inference single-file while callers
        # remain asynchronous at the MCP boundary.
        self._embedding_lock = threading.Lock()

    def _get_model(self):
        if self._model is None:
            with self._model_lock:
                if self._model is None:
                    from fastembed import TextEmbedding

                    self._model = TextEmbedding(model_name=self.model_name)
        return self._model

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        with self._embedding_lock:
            return [
                list(map(float, row))
                for row in self._get_model().embed(list(texts), batch_size=EMBEDDING_BATCH_SIZE)
            ]


class DeterministicTestEmbedder:
    """Dependency-free embedder used only by unit tests."""

    model_name = "deterministic-test-embedder"

    def __init__(self, dimensions: int = 64) -> None:
        self.dimensions = dimensions

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        output = []
        for text in texts:
            vector = [0.0] * self.dimensions
            for token in re.findall(r"[a-z0-9]+", text.lower()):
                digest = sha256(token.encode("utf-8")).digest()
                slot = int.from_bytes(digest[:4], "big") % self.dimensions
                vector[slot] += 1.0
            magnitude = math.sqrt(sum(value * value for value in vector)) or 1.0
            output.append([value / magnitude for value in vector])
        return output


def pack_vector(values: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def unpack_vector(blob: bytes) -> tuple[float, ...]:
    if not blob:
        return ()
    return struct.unpack(f"<{len(blob) // 4}f", blob)


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


@dataclass(frozen=True)
class NormalizedDocument:
    document_id: str
    product: str
    publication_date: Optional[str]
    title: str
    source_uri: str
    text: str
    content_hash: str
    parser_version: str = PARSER_VERSION
    section: Optional[str] = None
    page: Optional[int] = None
    media_type: str = "text/plain"
    metadata: Optional[dict[str, Any]] = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "NormalizedDocument":
        text = normalize_text(payload.get("text") or payload.get("excerpt") or payload.get("data"))
        supplied_hash = str(payload.get("contentHash") or "").lower()
        digest = content_hash(text)
        if supplied_hash and supplied_hash != digest:
            raise ValueError("contentHash does not match the normalized document text")
        source_uri = str(payload.get("sourceUri") or "").strip()
        product = str(payload.get("product") or "generic").strip().lower()
        publication_date = payload.get("publicationDate") or None
        document_id = str(payload.get("documentId") or "").strip() or stable_id(
            "doc", source_uri, product, publication_date, digest
        )
        return cls(
            document_id=document_id,
            product=product,
            publication_date=publication_date,
            title=str(payload.get("title") or product).strip(),
            source_uri=source_uri,
            text=text,
            content_hash=digest,
            parser_version=str(payload.get("parserVersion") or PARSER_VERSION),
            section=payload.get("section") or None,
            page=int(payload["page"]) if payload.get("page") is not None else None,
            media_type=str(payload.get("mediaType") or "text/plain"),
            metadata=dict(payload.get("metadata") or {}),
        )


class ResearchIndex:
    def __init__(self, db_path: Optional[Path | str] = None, embedder: Optional[Embedder] = None) -> None:
        path = Path(db_path) if db_path else default_data_dir() / "research.sqlite3"
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = path
        self.embedder = embedder or FastEmbedder()
        self._lock = threading.RLock()
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        return connection

    def _initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    document_id TEXT PRIMARY KEY,
                    product TEXT NOT NULL,
                    publication_date TEXT,
                    title TEXT NOT NULL,
                    source_uri TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    parser_version TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    indexed_at TEXT NOT NULL,
                    UNIQUE(source_uri, content_hash)
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    citation_id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
                    product TEXT NOT NULL,
                    publication_date TEXT,
                    section TEXT,
                    page INTEGER,
                    ordinal INTEGER NOT NULL,
                    excerpt TEXT NOT NULL,
                    symbol_terms TEXT NOT NULL,
                    embedding BLOB NOT NULL,
                    embedding_model TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_chunks_product_date
                    ON chunks(product, publication_date DESC);
                CREATE TABLE IF NOT EXISTS page_grants (
                    token TEXT PRIMARY KEY,
                    citation_id TEXT NOT NULL REFERENCES chunks(citation_id) ON DELETE CASCADE,
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sync_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS import_jobs (
                    import_id TEXT PRIMARY KEY,
                    staging_key TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    status TEXT NOT NULL,
                    detected_product TEXT,
                    detected_date TEXT,
                    page_count INTEGER,
                    failure_reason TEXT,
                    analysis_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            connection.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                    citation_id UNINDEXED,
                    excerpt,
                    product,
                    symbol_terms,
                    tokenize='porter unicode61'
                )
                """
            )

    def upsert_documents(self, documents: Iterable[NormalizedDocument]) -> dict[str, int]:
        materialized = [document for document in documents if document.text]
        if not materialized:
            return {"documents": 0, "chunks": 0, "unchanged": 0}
        unchanged = 0
        indexed_documents = 0
        indexed_chunks = 0
        prepared: list[tuple[NormalizedDocument, list[str], str]] = []
        with self._lock, self.connect() as connection:
            for document in materialized:
                existing = connection.execute(
                    "SELECT content_hash, parser_version FROM documents WHERE document_id = ?",
                    (document.document_id,),
                ).fetchone()
                if existing and existing["content_hash"] == document.content_hash and existing["parser_version"] == document.parser_version:
                    unchanged += 1
                    continue
                prepared.append((document, chunk_text(document.text), " ".join(extract_symbols(document.text))))

        # Embedding can be the slowest part of a backfill. Batch all changed
        # excerpts for this feed page before opening any write transaction so
        # model inference cannot block page grants or PDF imports.
        all_chunks = [excerpt for _document, chunks, _symbols in prepared for excerpt in chunks]
        all_embeddings = self.embedder.embed(all_chunks)
        if len(all_embeddings) != len(all_chunks):
            raise ValueError("Embedding provider returned an unexpected vector count")

        embedding_offset = 0
        for document, chunks, symbols in prepared:
            embeddings = all_embeddings[embedding_offset:embedding_offset + len(chunks)]
            embedding_offset += len(chunks)
            chunk_rows = []
            for ordinal, (excerpt, vector) in enumerate(zip(chunks, embeddings), start=1):
                citation_id = make_citation_id(
                    document_id=document.document_id,
                    content_hash=document.content_hash,
                    section=document.section,
                    page=document.page,
                    ordinal=ordinal,
                )
                chunk_rows.append((citation_id, ordinal, excerpt, pack_vector(vector)))

            with self._lock, self.connect() as connection:
                # Another ingestion request may have completed this document
                # while embeddings were generated. Recheck under the writer
                # lock before replacing anything.
                existing = connection.execute(
                    "SELECT content_hash, parser_version FROM documents WHERE document_id = ?",
                    (document.document_id,),
                ).fetchone()
                if existing and existing["content_hash"] == document.content_hash and existing["parser_version"] == document.parser_version:
                    unchanged += 1
                    continue
                old_ids = [
                    row["citation_id"]
                    for row in connection.execute(
                        "SELECT citation_id FROM chunks WHERE document_id = ?", (document.document_id,)
                    )
                ]
                if old_ids:
                    connection.executemany(
                        "DELETE FROM chunks_fts WHERE citation_id = ?", [(value,) for value in old_ids]
                    )
                connection.execute("DELETE FROM chunks WHERE document_id = ?", (document.document_id,))
                connection.execute("DELETE FROM documents WHERE document_id = ?", (document.document_id,))
                connection.execute(
                    """
                    INSERT INTO documents(
                        document_id, product, publication_date, title, source_uri,
                        content_hash, parser_version, media_type, metadata_json, indexed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        document.document_id,
                        document.product,
                        document.publication_date,
                        document.title,
                        document.source_uri,
                        document.content_hash,
                        document.parser_version,
                        document.media_type,
                        json.dumps(document.metadata or {}, sort_keys=True, default=str),
                        utc_now_iso(),
                    ),
                )
                for citation_id, ordinal, excerpt, packed_vector in chunk_rows:
                    connection.execute(
                        """
                        INSERT INTO chunks(
                            citation_id, document_id, product, publication_date, section,
                            page, ordinal, excerpt, symbol_terms, embedding, embedding_model
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            citation_id,
                            document.document_id,
                            document.product,
                            document.publication_date,
                            document.section,
                            document.page,
                            ordinal,
                            excerpt,
                            symbols,
                            packed_vector,
                            self.embedder.model_name,
                        ),
                    )
                    connection.execute(
                        "INSERT INTO chunks_fts(citation_id, excerpt, product, symbol_terms) VALUES (?, ?, ?, ?)",
                        (citation_id, excerpt, document.product, symbols),
                    )
            indexed_chunks += len(chunk_rows)
            indexed_documents += 1
        return {"documents": indexed_documents, "chunks": indexed_chunks, "unchanged": unchanged}

    @staticmethod
    def _fts_query(query: str) -> str:
        terms = re.findall(r"[A-Za-z0-9][A-Za-z0-9._-]*", query)[:20]
        return " OR ".join(f'"{term.replace(chr(34), "")}"' for term in terms)

    @staticmethod
    def _filter_clause(
        *, product: Optional[str], symbol: Optional[str], start_date: Optional[str], end_date: Optional[str]
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if product:
            clauses.append("c.product = ?")
            params.append(product.lower())
        if symbol:
            clauses.append("(' ' || c.symbol_terms || ' ') LIKE ?")
            params.append(f"% {symbol.upper()} %")
        if start_date:
            clauses.append("c.publication_date >= ?")
            params.append(start_date)
        if end_date:
            clauses.append("c.publication_date <= ?")
            params.append(end_date)
        return (" AND " + " AND ".join(clauses)) if clauses else "", params

    def search(
        self,
        query: str,
        *,
        product: Optional[str] = None,
        symbol: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        limit: int = DEFAULT_RESULT_LIMIT,
    ) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), MAX_RESULT_LIMIT))
        query = normalize_text(query)
        if not query:
            return []
        filter_sql, filter_params = self._filter_clause(
            product=product, symbol=symbol, start_date=start_date, end_date=end_date
        )
        lexical: list[sqlite3.Row] = []
        fts_query = self._fts_query(query)
        with self.connect() as connection:
            if fts_query:
                lexical = connection.execute(
                    f"""
                    SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type,
                           bm25(chunks_fts, 0.0, 1.0, 0.15, 0.4) AS lexical_score
                    FROM chunks_fts
                    JOIN chunks c ON c.citation_id = chunks_fts.citation_id
                    JOIN documents d ON d.document_id = c.document_id
                    WHERE chunks_fts MATCH ? {filter_sql}
                    ORDER BY lexical_score ASC
                    LIMIT 80
                    """,
                    [fts_query, *filter_params],
                ).fetchall()
            candidates = connection.execute(
                f"""
                SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type
                FROM chunks c JOIN documents d ON d.document_id = c.document_id
                WHERE 1=1 {filter_sql}
                ORDER BY c.publication_date DESC, c.document_id, c.ordinal
                LIMIT 2000
                """,
                filter_params,
            ).fetchall()

        query_vector = self.embedder.embed([query])[0]
        vector_ranked = sorted(
            ((cosine_similarity(query_vector, unpack_vector(row["embedding"])), row) for row in candidates),
            key=lambda pair: pair[0],
            reverse=True,
        )[:80]
        scores: dict[str, float] = {}
        rows: dict[str, sqlite3.Row] = {}
        for rank, row in enumerate(lexical, start=1):
            citation_id = row["citation_id"]
            scores[citation_id] = scores.get(citation_id, 0.0) + 1.0 / (60 + rank)
            rows[citation_id] = row
        for rank, (similarity, row) in enumerate(vector_ranked, start=1):
            citation_id = row["citation_id"]
            scores[citation_id] = scores.get(citation_id, 0.0) + max(0.0, similarity) / (60 + rank)
            rows[citation_id] = row
        ordered = sorted(scores, key=lambda citation_id: scores[citation_id], reverse=True)
        output: list[dict[str, Any]] = []
        total_chars = 0
        for citation_id in ordered:
            row = rows[citation_id]
            excerpt = row["excerpt"][:MAX_EXCERPT_CHARS]
            if total_chars + len(excerpt) > MAX_RESULT_TEXT_CHARS:
                break
            page_token = self._grant_page(row) if row["page"] is not None and row["media_type"] == "application/pdf" else None
            citation = Citation(
                id=citation_id,
                documentId=row["document_id"],
                product=row["product"],
                publicationDate=row["publication_date"],
                sourceUri=row["source_uri"],
                title=row["title"],
                section=row["section"],
                page=row["page"],
                excerpt=excerpt,
                contentHash=row["content_hash"],
                pageToken=page_token,
            ).as_dict()
            output.append({"score": round(scores[citation_id], 8), "excerpt": excerpt, "citation": citation})
            total_chars += len(excerpt)
            if len(output) >= safe_limit:
                break
        return output

    def _grant_page(self, row: sqlite3.Row) -> str:
        expires = datetime.now(timezone.utc) + timedelta(minutes=PAGE_GRANT_TTL_MINUTES)
        token = stable_id("page", row["citation_id"], utc_now_iso(), os.urandom(16).hex())
        with self.connect() as connection:
            connection.execute("DELETE FROM page_grants WHERE expires_at < ?", (utc_now_iso(),))
            connection.execute(
                "INSERT INTO page_grants(token, citation_id, expires_at) VALUES (?, ?, ?)",
                (token, row["citation_id"], expires.isoformat().replace("+00:00", "Z")),
            )
        return token

    def resolve_page_grant(self, citation_id: str, token: str) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type
                FROM page_grants g
                JOIN chunks c ON c.citation_id = g.citation_id
                JOIN documents d ON d.document_id = c.document_id
                WHERE g.token = ? AND g.citation_id = ? AND g.expires_at >= ?
                """,
                (token, citation_id, utc_now_iso()),
            ).fetchone()
        return dict(row) if row else None

    def get_source(self, citation_id: str) -> Optional[dict[str, Any]]:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type, d.metadata_json
                FROM chunks c JOIN documents d ON d.document_id = c.document_id
                WHERE c.citation_id = ?
                """,
                (citation_id,),
            ).fetchone()
        if not row:
            return None
        result = dict(row)
        result["metadata"] = json.loads(result.pop("metadata_json") or "{}")
        result.pop("embedding", None)
        return result

    def latest_by_product(self) -> dict[str, dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT d.* FROM documents d
                JOIN (
                    SELECT product, MAX(COALESCE(publication_date, '')) AS latest_date
                    FROM documents GROUP BY product
                ) latest ON latest.product = d.product
                  AND COALESCE(d.publication_date, '') = latest.latest_date
                ORDER BY d.product, d.indexed_at DESC
                """
            ).fetchall()
        output: dict[str, dict[str, Any]] = {}
        for row in rows:
            output.setdefault(row["product"], dict(row))
        return output

    def recent_documents_by_product(self, dates_per_product: int = 2) -> list[dict[str, Any]]:
        """Return exact newest/prior documents without semantic top-k selection."""
        safe_dates = max(1, min(int(dates_per_product), 5))
        with self.connect() as connection:
            rows = connection.execute(
                """
                WITH ranked_dates AS (
                    SELECT product, publication_date,
                           DENSE_RANK() OVER (
                               PARTITION BY product
                               ORDER BY COALESCE(publication_date, '') DESC
                           ) AS date_rank
                    FROM documents
                    GROUP BY product, publication_date
                )
                SELECT d.*
                FROM documents d
                JOIN ranked_dates r
                  ON r.product = d.product
                 AND COALESCE(r.publication_date, '') = COALESCE(d.publication_date, '')
                WHERE r.date_rank <= ?
                ORDER BY d.product, COALESCE(d.publication_date, '') DESC, d.indexed_at DESC
                """,
                (safe_dates,),
            ).fetchall()
        return [dict(row) for row in rows]

    def excerpts_for_publication_date(self, publication_date: str) -> list[dict[str, Any]]:
        """Scan every indexed chunk on one exact date in stable source order."""
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type
                FROM chunks c JOIN documents d ON d.document_id = c.document_id
                WHERE c.publication_date = ?
                ORDER BY c.product, c.document_id, c.ordinal
                """,
                (str(publication_date),),
            ).fetchall()
        output = []
        for row in rows:
            excerpt = row["excerpt"][:MAX_EXCERPT_CHARS]
            citation = Citation(
                id=row["citation_id"],
                documentId=row["document_id"],
                product=row["product"],
                publicationDate=row["publication_date"],
                sourceUri=row["source_uri"],
                title=row["title"],
                section=row["section"],
                page=row["page"],
                excerpt=excerpt,
                contentHash=row["content_hash"],
            ).as_dict()
            output.append({"excerpt": excerpt, "citation": citation})
        return output

    def latest_excerpts(self, product: str, publication_date: Optional[str], limit: int = 2) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 12))
        date_clause = "c.publication_date IS NULL" if publication_date is None else "c.publication_date = ?"
        params: list[Any] = [product]
        if publication_date is not None:
            params.append(publication_date)
        params.append(safe_limit)
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type
                FROM chunks c JOIN documents d ON d.document_id = c.document_id
                WHERE c.product = ? AND {date_clause}
                ORDER BY c.document_id, c.ordinal
                LIMIT ?
                """,
                params,
            ).fetchall()
        output = []
        for row in rows:
            page_token = self._grant_page(row) if row["page"] is not None and row["media_type"] == "application/pdf" else None
            excerpt = row["excerpt"][:MAX_EXCERPT_CHARS]
            citation = Citation(
                id=row["citation_id"],
                documentId=row["document_id"],
                product=row["product"],
                publicationDate=row["publication_date"],
                sourceUri=row["source_uri"],
                title=row["title"],
                section=row["section"],
                page=row["page"],
                excerpt=excerpt,
                contentHash=row["content_hash"],
                pageToken=page_token,
            ).as_dict()
            output.append({"excerpt": excerpt, "citation": citation})
        return output

    def document_excerpts(self, document_id: str, limit: int = 24) -> list[dict[str, Any]]:
        """Return source-ordered excerpts from one exact indexed document."""
        safe_limit = max(1, min(int(limit), 24))
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT c.*, d.title, d.source_uri, d.content_hash, d.media_type
                FROM chunks c JOIN documents d ON d.document_id = c.document_id
                WHERE c.document_id = ?
                ORDER BY c.ordinal
                LIMIT ?
                """,
                [str(document_id), safe_limit],
            ).fetchall()
        output = []
        for row in rows:
            page_token = self._grant_page(row) if row["page"] is not None and row["media_type"] == "application/pdf" else None
            excerpt = row["excerpt"][:MAX_EXCERPT_CHARS]
            citation = Citation(
                id=row["citation_id"],
                documentId=row["document_id"],
                product=row["product"],
                publicationDate=row["publication_date"],
                sourceUri=row["source_uri"],
                title=row["title"],
                section=row["section"],
                page=row["page"],
                excerpt=excerpt,
                contentHash=row["content_hash"],
                pageToken=page_token,
            ).as_dict()
            output.append({"excerpt": excerpt, "citation": citation})
        return output

    def coverage_counts(self) -> dict[str, Any]:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS documents, (SELECT COUNT(*) FROM chunks) AS chunks FROM documents"
            ).fetchone()
            by_product = [
                dict(item)
                for item in connection.execute(
                    "SELECT product, COUNT(*) AS documents, MAX(publication_date) AS latestDate FROM documents GROUP BY product"
                )
            ]
        return {"documents": row["documents"], "chunks": row["chunks"], "byProduct": by_product}

    def set_sync_state(self, key: str, value: str) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO sync_state(key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, value, utc_now_iso()),
            )

    def get_sync_state(self, key: str, default: str = "") -> str:
        with self.connect() as connection:
            row = connection.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else default
