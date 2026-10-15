"""Constrained PDF intake and selected-page rendering for The Analyst."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from hashlib import sha256
import json
import mimetypes
import os
from pathlib import Path
import re
import time
from typing import Any, Optional
from urllib.parse import urlparse

from pdf_worker_client import PdfWorkerError, check_cancelled, native_pdf, run_pdf_operation
import httpx

from contracts import stable_id, utc_now_iso
from index import NormalizedDocument, ResearchIndex, normalize_text


MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PDF_PAGES = int(os.environ.get("ANALYST_MAX_PDF_PAGES", "500"))
MAX_SELECTED_PAGE_BYTES = int(os.environ.get("ANALYST_MAX_SELECTED_PAGE_BYTES", str(8 * 1024 * 1024)))
PDF_FETCH_TIMEOUT_SECONDS = float(os.environ.get("ANALYST_PDF_FETCH_TIMEOUT_SEC", "45"))
TEXTRACT_PAGE_LIMIT = int(os.environ.get("ANALYST_TEXTRACT_PAGE_LIMIT", "40"))
DATE_PATTERNS = (
    re.compile(r"\b(20\d{2})[-_/ .](0?[1-9]|1[0-2])[-_/ .](0?[1-9]|[12]\d|3[01])\b"),
    re.compile(r"\b(0?[1-9]|1[0-2])[-_/ .](0?[1-9]|[12]\d|3[01])[-_/ .](20\d{2})\b"),
)
PDF_METADATA_DATE_PATTERN = re.compile(r"^D:(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])")


class PdfValidationError(ValueError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def validate_pdf_bytes(data: bytes, *, content_type: Optional[str] = None) -> None:
    if len(data) > MAX_PDF_BYTES:
        raise PdfValidationError("PDF exceeds the 50 MB maximum.", "pdf_oversize")
    normalized_mime = str(content_type or "").partition(";")[0].strip().lower()
    if normalized_mime and normalized_mime != "application/pdf":
        raise PdfValidationError(f"Expected application/pdf, received {normalized_mime}.", "invalid_mime")
    if not data.startswith(b"%PDF-"):
        raise PdfValidationError("File signature is not a PDF.", "invalid_signature")


def detect_publication_date(text: str) -> Optional[str]:
    for index, pattern in enumerate(DATE_PATTERNS):
        for match in pattern.finditer(text):
            parts = [int(value) for value in match.groups()]
            year, month, day = parts if index == 0 else (parts[2], parts[0], parts[1])
            try:
                return datetime(year, month, day, tzinfo=timezone.utc).date().isoformat()
            except ValueError:
                continue
    return None


def detect_pdf_metadata_date(metadata: Optional[dict[str, Any]]) -> Optional[str]:
    """Prefer the PDF creation date, then modification date, for undated covers."""
    for key in ("creationDate", "modDate"):
        match = PDF_METADATA_DATE_PATTERN.match(str((metadata or {}).get(key) or ""))
        if not match:
            continue
        try:
            return datetime(
                int(match.group(1)),
                int(match.group(2)),
                int(match.group(3)),
                tzinfo=timezone.utc,
            ).date().isoformat()
        except ValueError:
            continue
    return None


def detect_product(text: str, registry: dict[str, Any]) -> tuple[Optional[str], list[dict[str, Any]]]:
    haystack = text.lower()
    scored = []
    for product in registry.get("products", []):
        terms = [str(term).strip().lower() for term in product.get("matchTerms", []) if str(term).strip()]
        matched = sorted({term for term in terms if term in haystack})
        if matched:
            score = sum(max(1, len(term.split())) for term in matched)
            scored.append({"product": product.get("id"), "score": score, "matchedTerms": matched})
    scored.sort(key=lambda row: (-row["score"], str(row["product"])))
    if not scored:
        return None, []
    if len(scored) > 1 and scored[0]["score"] == scored[1]["score"]:
        return None, scored[:5]
    return str(scored[0]["product"]), scored[:5]


async def fetch_pdf(url: str, *, expected_content_type: Optional[str] = None) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise PdfValidationError("Only HTTPS/HTTP staging URLs are accepted.", "invalid_staging_url")
    total = 0
    chunks = []
    async with httpx.AsyncClient(follow_redirects=False, timeout=PDF_FETCH_TIMEOUT_SECONDS) as client:
        async with client.stream("GET", url, headers={"Accept": "application/pdf"}) as response:
            response.raise_for_status()
            header_type = response.headers.get("content-type") or expected_content_type
            header_length = response.headers.get("content-length")
            if header_length and int(header_length) > MAX_PDF_BYTES:
                raise PdfValidationError("PDF exceeds the 50 MB maximum.", "pdf_oversize")
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_PDF_BYTES:
                    raise PdfValidationError("PDF exceeds the 50 MB maximum.", "pdf_oversize")
                chunks.append(chunk)
    data = b"".join(chunks)
    validate_pdf_bytes(data, content_type=header_type)
    return data


def _native(data: bytes, operation: str, argument: int) -> bytes:
    try:
        return native_pdf(data, operation, argument)
    except PdfWorkerError as exc:
        raise PdfValidationError(str(exc), exc.code) from exc


def _textract_page(data: bytes, page_number: int) -> str:
    if os.environ.get("ANALYST_TEXTRACT_FALLBACK", "true").lower() != "true":
        return ""
    import boto3
    from botocore.config import Config

    image = _native(data, "render", page_number)
    response = boto3.client("textract", config=Config(connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1})).detect_document_text(Document={"Bytes": image})
    return normalize_text("\n".join(
        block.get("Text", "") for block in response.get("Blocks", [])
        if block.get("BlockType") == "LINE" and block.get("Text")
    ))


def extract_pdf(data: bytes, *, content_type: Optional[str] = "application/pdf") -> dict[str, Any]:
    validate_pdf_bytes(data, content_type=content_type)
    deadline = time.monotonic() + 90
    extracted = json.loads(_native(data, "extract", min(500, MAX_PDF_PAGES)))
    pages = extracted["pages"]
    warnings = []
    ocr_count = 0
    for index, page in enumerate(pages):
        check_cancelled()
        page["text"] = normalize_text(page["text"])
        if len(page["text"]) < 30 and index < TEXTRACT_PAGE_LIMIT:
            if time.monotonic() >= deadline:
                warnings.append("OCR stopped after its document processing budget.")
                break
            try:
                ocr_text = _textract_page(data, page["page"])
                if len(ocr_text) > len(page["text"]):
                    page["text"] = ocr_text
                    page["extraction"] = "textract"
                    ocr_count += 1
            except Exception as exc:
                warnings.append(f"Page {page['page']} OCR fallback failed: {exc}")
    searchable_pages = sum(1 for page in pages if page["text"])
    if searchable_pages == 0:
        raise PdfValidationError("No searchable text was extracted; OCR was unavailable or unsuccessful.", "ocr_failure")
    return {
        "pageCount": extracted["pageCount"],
        "searchablePageCount": searchable_pages,
        "ocrPageCount": ocr_count,
        "documentDate": detect_pdf_metadata_date(extracted.get("metadata")),
        "pages": pages,
        "warnings": warnings,
    }


def normalized_pdf_documents(
    data: bytes,
    *,
    source_uri: str,
    product: str,
    publication_date: str,
    title: str,
    expected_sha256: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> tuple[list[NormalizedDocument], dict[str, Any]]:
    digest = sha256(data).hexdigest()
    if expected_sha256 and digest != expected_sha256:
        raise PdfValidationError("Archived PDF checksum does not match its immutable ledger record.", "digest_mismatch")
    extracted = extract_pdf(data, content_type="application/pdf")
    base_source_uri = source_uri.split("#", 1)[0]
    base_document_id = stable_id("doc", base_source_uri, digest)
    documents = []
    for page in extracted["pages"]:
        if not page["text"]:
            continue
        documents.append(
            NormalizedDocument.from_payload(
                {
                    "documentId": f"{base_document_id}:p{page['page']}",
                    "product": product,
                    "publicationDate": publication_date,
                    "title": title,
                    "sourceUri": f"{base_source_uri}#page={page['page']}",
                    "text": page["text"],
                    "parserVersion": "analyst-pdf-direct-textract-v1",
                    "section": f"Page {page['page']}",
                    "page": page["page"],
                    "mediaType": "application/pdf",
                    "metadata": {
                        **(metadata or {}),
                        "pdfSha256": digest,
                        "baseDocumentId": base_document_id,
                        "baseSourceUri": base_source_uri,
                        "extraction": page["extraction"],
                    },
                }
            )
        )
    return documents, {
        "sha256": digest,
        "pageCount": extracted["pageCount"],
        "searchablePageCount": extracted["searchablePageCount"],
        "ocrPageCount": extracted["ocrPageCount"],
        "warnings": extracted["warnings"],
    }


class PdfLibrary:
    def __init__(self, index: ResearchIndex, registry: dict[str, Any]) -> None:
        self.index = index
        self.registry = registry

    async def analyze(
        self,
        *,
        staging_key: str,
        filename: str,
        download_url: str,
        content_type: str,
    ) -> dict[str, Any]:
        try:
            data = await fetch_pdf(download_url, expected_content_type=content_type)
            extracted = await run_pdf_operation(extract_pdf, data, content_type=content_type)
            digest = sha256(data).hexdigest()
            detection_text = normalize_text(
                f"{filename}\n" + "\n".join(page["text"] for page in extracted["pages"][:5])
            )
            product, candidates = detect_product(detection_text, self.registry)
            publication_date = detect_publication_date(detection_text) or extracted.get("documentDate")
            existing = self._find_committed_digest(digest)
            import_id = stable_id("import", staging_key, digest, utc_now_iso())
            status = "duplicate" if existing else "awaiting_confirmation"
            analysis = {
                "importId": import_id,
                "status": status,
                "stagingKey": staging_key,
                "filename": filename,
                "sha256": digest,
                "detectedProduct": product,
                "productCandidates": candidates,
                "detectedPublicationDate": publication_date,
                "pageCount": extracted["pageCount"],
                "searchablePageCount": extracted["searchablePageCount"],
                "ocrPageCount": extracted["ocrPageCount"],
                "warnings": extracted["warnings"],
                "duplicateOf": existing,
            }
            self._record_job(analysis)
            return analysis
        except Exception as exc:
            import_id = stable_id("import", staging_key, filename, utc_now_iso())
            analysis = {
                "importId": import_id,
                "status": "failed",
                "stagingKey": staging_key,
                "filename": filename,
                "sha256": "",
                "detectedProduct": None,
                "detectedPublicationDate": None,
                "pageCount": None,
                "warnings": [],
                "failureReason": str(exc),
                "failureCode": getattr(exc, "code", "analysis_failed"),
            }
            self._record_job(analysis)
            raise

    async def commit(
        self,
        *,
        import_id: str,
        source_uri: str,
        download_url: str,
        product: str,
        publication_date: str,
        expected_sha256: str,
        title: Optional[str] = None,
    ) -> dict[str, Any]:
        job = self.get_job(import_id)
        if not job:
            raise PdfValidationError("Import analysis was not found.", "import_not_found")
        if job["status"] == "duplicate":
            raise PdfValidationError("This PDF is already in the source library.", "duplicate_pdf")
        known_products = {str(row.get("id")) for row in self.registry.get("products", [])}
        if product != "generic" and product not in known_products:
            raise PdfValidationError("Confirmed product is not registered.", "invalid_product")
        if not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", publication_date or ""):
            raise PdfValidationError("Publication date must be confirmed as YYYY-MM-DD.", "missing_date")
        data = await fetch_pdf(download_url, expected_content_type="application/pdf")
        digest = sha256(data).hexdigest()
        if digest != expected_sha256 or digest != job["sha256"]:
            raise PdfValidationError("PDF changed after analysis.", "digest_mismatch")
        duplicate = self._find_committed_digest(digest)
        if duplicate and duplicate != import_id:
            raise PdfValidationError("This PDF is already in the source library.", "duplicate_pdf")
        documents, pdf_result = await run_pdf_operation(
            normalized_pdf_documents,
            data,
            source_uri=source_uri,
            product=product,
            publication_date=publication_date,
            title=title or job["filename"],
            expected_sha256=digest,
            metadata={"importId": import_id},
        )
        indexed = await asyncio.to_thread(self.index.upsert_documents, documents)
        now = utc_now_iso()
        with self.index.connect() as connection:
            connection.execute(
                "UPDATE import_jobs SET status='committed', updated_at=?, analysis_json=? WHERE import_id=?",
                (
                    now,
                    json.dumps(
                        {
                            **json.loads(job["analysis_json"]),
                            "confirmedProduct": product,
                            "confirmedPublicationDate": publication_date,
                            "sourceUri": source_uri,
                            "indexed": indexed,
                        },
                        sort_keys=True,
                    ),
                    import_id,
                ),
            )
        return {
            "importId": import_id,
            "status": "committed",
            "sourceUri": source_uri,
            "sha256": digest,
            "product": product,
            "publicationDate": publication_date,
            "pageCount": pdf_result["pageCount"],
            "indexed": indexed,
            "warnings": pdf_result["warnings"],
        }

    def _record_job(self, analysis: dict[str, Any]) -> None:
        now = utc_now_iso()
        with self.index.connect() as connection:
            connection.execute(
                """
                INSERT INTO import_jobs(
                    import_id, staging_key, filename, sha256, status, detected_product,
                    detected_date, page_count, failure_reason, analysis_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(import_id) DO UPDATE SET
                    status=excluded.status, failure_reason=excluded.failure_reason,
                    analysis_json=excluded.analysis_json, updated_at=excluded.updated_at
                """,
                (
                    analysis["importId"],
                    analysis.get("stagingKey", ""),
                    analysis.get("filename", ""),
                    analysis.get("sha256", ""),
                    analysis.get("status", "failed"),
                    analysis.get("detectedProduct"),
                    analysis.get("detectedPublicationDate"),
                    analysis.get("pageCount"),
                    analysis.get("failureReason"),
                    json.dumps(analysis, sort_keys=True, default=str),
                    now,
                    now,
                ),
            )

    def mark_failed(self, import_id: str, *, reason: str, code: str) -> None:
        job = self.get_job(import_id)
        if not job:
            return
        analysis = json.loads(job.get("analysis_json") or "{}")
        analysis.update(
            status="failed",
            failureReason=reason,
            failureCode=code,
        )
        with self.index.connect() as connection:
            connection.execute(
                """
                UPDATE import_jobs
                SET status='failed', failure_reason=?, analysis_json=?, updated_at=?
                WHERE import_id=?
                """,
                (reason, json.dumps(analysis, sort_keys=True, default=str), utc_now_iso(), import_id),
            )

    def _find_committed_digest(self, digest: str) -> Optional[str]:
        if not digest:
            return None
        with self.index.connect() as connection:
            row = connection.execute(
                "SELECT import_id FROM import_jobs WHERE sha256=? AND status='committed' LIMIT 1",
                (digest,),
            ).fetchone()
        return row["import_id"] if row else None

    def get_job(self, import_id: str) -> Optional[dict[str, Any]]:
        with self.index.connect() as connection:
            row = connection.execute("SELECT * FROM import_jobs WHERE import_id=?", (import_id,)).fetchone()
        return dict(row) if row else None

    def list_jobs(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.index.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?", (max(1, min(limit, 200)),)
            ).fetchall()
        output = []
        for row in rows:
            result = dict(row)
            result["analysis"] = json.loads(result.pop("analysis_json") or "{}")
            output.append(result)
        return output


def read_source_bytes(source_uri: str) -> bytes:
    parsed = urlparse(source_uri)
    if parsed.scheme == "s3":
        bucket = parsed.netloc
        key = parsed.path.lstrip("/")
        allowed_bucket = os.environ.get("ANALYST_RESEARCH_BUCKET", "market-dashboard-csv-data")
        prefixes = [
            value.strip()
            for value in os.environ.get(
                "ANALYST_ALLOWED_S3_PREFIXES",
                "hedgeye-email/,hedgeye-uploads/,research/,analyst-research/",
            ).split(",")
            if value.strip()
        ]
        if bucket != allowed_bucket or not any(key.startswith(prefix) for prefix in prefixes):
            raise PdfValidationError("PDF source URI is outside the approved research prefixes.", "source_not_allowed")
        import boto3

        response = boto3.client("s3").get_object(Bucket=bucket, Key=key)
        data = response["Body"].read(MAX_PDF_BYTES + 1)
        validate_pdf_bytes(data, content_type=response.get("ContentType") or "application/pdf")
        return data
    if parsed.scheme == "file" and os.environ.get("ANALYST_ALLOW_FILE_SOURCES") == "true":
        path = Path(parsed.path).resolve()
        allowed_root = Path(os.environ.get("ANALYST_FILE_SOURCE_ROOT", "/nonexistent")).resolve()
        if allowed_root not in path.parents:
            raise PdfValidationError("Local PDF source is outside the approved root.", "source_not_allowed")
        data = path.read_bytes()
        validate_pdf_bytes(data, content_type=mimetypes.guess_type(path.name)[0])
        return data
    raise PdfValidationError("Only approved S3 PDF sources may be rendered.", "source_not_allowed")


def render_selected_page(source_uri: str, page_number: int) -> bytes:
    if page_number < 1:
        raise PdfValidationError("Page numbers start at 1.", "invalid_page")
    data = read_source_bytes(source_uri)
    image = _native(data, "render", page_number)
    if len(image) > MAX_SELECTED_PAGE_BYTES:
        raise PdfValidationError("Rendered page exceeds the image response limit.", "page_image_oversize")
    return image
