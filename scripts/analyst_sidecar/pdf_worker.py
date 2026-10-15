"""Disposable native PDF process. No application, cloud or model imports."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import resource
import sys

# Native libraries may write diagnostics directly to file descriptor 1 during
# import or parsing. Reserve the original pipe for the JSON error protocol.
_protocol_output = None
if __name__ == "__main__":
    _protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), "w")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

import pymupdf as fitz

MAX_PIXELS = 10_000_000
MAX_EDGE = 4096
MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def render_scale(width: float, height: float, requested: float = 2.0) -> float:
    if not all(math.isfinite(value) and value > 0 for value in (width, height, requested)):
        raise ValueError("invalid_page_geometry")
    scale = min(requested, MAX_EDGE / width, MAX_EDGE / height, math.sqrt(MAX_PIXELS / (width * height)))
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("invalid_page_geometry")
    # Account for MuPDF rounding each edge upward to the next pixel.
    while math.ceil(width * scale) * math.ceil(height * scale) > MAX_PIXELS:
        scale *= 0.999
    return scale


def extract(document, max_pages: int) -> bytes:
    if document.page_count < 1:
        raise ValueError("empty_pdf")
    if document.page_count > max_pages:
        raise ValueError("page_limit")
    pages = []
    text_bytes = 0
    for page in document:
        text = page.get_text("text")
        text_bytes += len(text.encode("utf-8"))
        if text_bytes > 16 * 1024 * 1024:
            raise ValueError("text_output_oversize")
        pages.append({"page": page.number + 1, "text": text, "extraction": "direct"})
    return json.dumps({"pageCount": document.page_count, "metadata": document.metadata, "pages": pages}).encode()


def render(document, page_number: int) -> bytes:
    if not 1 <= page_number <= document.page_count:
        raise ValueError("invalid_page")
    page = document.load_page(page_number - 1)
    scale = render_scale(page.rect.width, page.rect.height)
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csRGB)
    image = pixmap.tobytes("png")
    if len(image) > MAX_IMAGE_BYTES:
        raise ValueError("page_image_oversize")
    return image


def main() -> int:
    # Darwin does not reliably enforce RLIMIT_AS for native mappings. The
    # parent additionally monitors RSS there (and on Linux), then kills/reaps.
    resource.setrlimit(resource.RLIMIT_CPU, (60, 61))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    operation, input_path, output_path, argument = sys.argv[1:]
    try:
        with fitz.open(input_path) as document:
            data = extract(document, int(argument)) if operation == "extract" else render(document, int(argument))
        if len(data) > MAX_OUTPUT_BYTES:
            raise ValueError("pdf_output_oversize")
        Path(output_path).write_bytes(data)
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) else "parser_failure"
        output = _protocol_output if _protocol_output is not None else sys.stdout
        output.write(json.dumps({"code": code[:100]}))
        output.flush()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
