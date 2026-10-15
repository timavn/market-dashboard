#!/usr/bin/env python3
"""Stage a Market Situation-only parser overlay and optionally replay local evidence.

This command never deploys, writes AWS data, or changes IAM/runtime settings. It
starts from a backed-up deployed ZIP and preserves every unrelated member and
parser statement. Review the emitted diff and manifest before deployment.
"""

import argparse
import ast
import copy
import difflib
import hashlib
import importlib.util
import json
import zipfile
from datetime import datetime
from decimal import Decimal
from pathlib import Path


PARSER_MEMBER = "parse_hedgeye_email_html.py"
HANDLER_MEMBER = "hermes_gmail_ingestor.py"
OVERLAY_SYMBOLS = (
    "MARKET_SITUATION_SCHEMA_VERSION",
    "MARKET_SITUATION_CHART_METRICS_PARSER_VERSION",
    "_MARKET_SITUATION_IGNORED_TEXT",
    "_clean_market_situation_text",
    "_market_situation_chart_ocr_response",
    "_market_situation_ocr_text",
    "_market_situation_decimal_metric",
    "_market_situation_chart_date",
    "_extract_spx_gamma_volatility_throttle_metric",
    "_market_situation_strikes_in_play",
    "_extract_spx_probable_volatility_gamma_metric",
    "_extract_market_situation_signals",
)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def symbol_name(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return node.name
    if isinstance(node, ast.Assign) and len(node.targets) == 1:
        target = node.targets[0]
        return target.id if isinstance(target, ast.Name) else None
    return None


def market_branch(tree):
    functions = [node for node in tree.body if symbol_name(node) == "parse_html_snapshot"]
    if len(functions) != 1:
        raise ValueError("Expected exactly one parse_html_snapshot function")
    expected = ast.dump(ast.parse("report_type == 'market-structure'", mode="eval").body)
    branches = [
        node for node in functions[0].body
        if isinstance(node, ast.If) and ast.dump(node.test) == expected
    ]
    if len(branches) != 1 or branches[0].orelse:
        raise ValueError("Expected one standalone Market Situation branch")
    return branches[0]


def unrelated_ast(tree):
    tree = copy.deepcopy(tree)
    tree.body = [node for node in tree.body if symbol_name(node) not in OVERLAY_SYMBOLS]
    market_branch(tree).body = [ast.Pass()]
    return ast.dump(tree, include_attributes=False)


def overlay_parser(deployed, local):
    """Apply explicit AST-delimited edits without reformatting untouched text."""
    before, source = ast.parse(deployed), ast.parse(local)
    deployed_symbols = {symbol_name(node): node for node in before.body}
    local_symbols = {symbol_name(node): node for node in source.body}
    missing = [name for name in OVERLAY_SYMBOLS if name not in local_symbols]
    if missing:
        raise ValueError(f"Local parser is missing required overlay symbols: {missing}")
    deployed_lines, local_lines = deployed.splitlines(True), local.splitlines(True)
    edits, additions, changed = [], [], []
    for name in OVERLAY_SYMBOLS:
        replacement = local_symbols[name]
        original = deployed_symbols.get(name)
        if original is not None and ast.dump(original) == ast.dump(replacement):
            continue
        changed.append(name)
        fragment = "".join(local_lines[replacement.lineno - 1:replacement.end_lineno])
        if original is None:
            additions.append(fragment.rstrip() + "\n\n\n")
        else:
            edits.append((original.lineno - 1, original.end_lineno, fragment))
    original_branch, replacement_branch = market_branch(before), market_branch(source)
    fragment = "".join(local_lines[replacement_branch.lineno - 1:replacement_branch.end_lineno])
    edits.append((original_branch.lineno - 1, original_branch.end_lineno, fragment))
    # New helpers are inserted before the parser entry point, after imports and
    # existing helpers. Runtime lookups therefore resolve without new imports.
    parser_line = deployed_symbols["parse_html_snapshot"].lineno - 1
    if additions:
        edits.append((parser_line, parser_line, "".join(additions)))
    for start, end, fragment in sorted(edits, reverse=True):
        deployed_lines[start:end] = [fragment]
    patched = "".join(deployed_lines)
    after = ast.parse(patched)
    if unrelated_ast(before) != unrelated_ast(after):
        raise ValueError("Overlay unexpectedly changed unrelated parser statements")
    compile(patched, PARSER_MEMBER, "exec")
    return patched, changed


def enable_market_ocr(source):
    """Add the one report type needed to pass Textract into the parser."""
    before = ast.parse(source)
    matches = [node for node in before.body if symbol_name(node) == "HTML_TEXTRACT_REPORT_TYPES"]
    if len(matches) != 1:
        raise ValueError("Expected one HTML_TEXTRACT_REPORT_TYPES assignment")
    node = matches[0]
    value = node.value
    if not (isinstance(value, ast.Call) and isinstance(value.func, ast.Name)
            and value.func.id == "frozenset" and len(value.args) == 1
            and isinstance(value.args[0], ast.Set) and not value.keywords):
        raise ValueError("Unexpected HTML_TEXTRACT_REPORT_TYPES declaration")
    report_types = ast.literal_eval(value.args[0])
    if "market-structure" in report_types:
        return source
    lines = source.splitlines(True)
    if lines[node.end_lineno - 1].strip() != "})" or not lines[node.end_lineno - 2].rstrip().endswith(","):
        raise ValueError("Unsupported report-type declaration layout; review manually")
    lines.insert(node.end_lineno - 1, '    "market-structure",\n')
    patched = "".join(lines)
    after = ast.parse(patched)
    updated = next(item for item in after.body if symbol_name(item) == "HTML_TEXTRACT_REPORT_TYPES")
    if ast.literal_eval(updated.value.args[0]) != report_types | {"market-structure"}:
        raise ValueError("Unexpected OCR report-type change")
    for tree in (before, after):
        tree.body = [item for item in tree.body if symbol_name(item) != "HTML_TEXTRACT_REPORT_TYPES"]
    if ast.dump(before) != ast.dump(after):
        raise ValueError("Unexpected unrelated handler change")
    compile(patched, HANDLER_MEMBER, "exec")
    return patched


def stage(deployed_package, local_parser, output_dir):
    deployed_package, local_parser, output_dir = map(Path, (deployed_package, local_parser, output_dir))
    package_bytes, local_bytes = deployed_package.read_bytes(), local_parser.read_bytes()
    output_dir.mkdir(parents=True, exist_ok=True)
    package = output_dir / "market-structure-metrics.staged.zip"
    if package.resolve() == deployed_package.resolve():
        raise ValueError("Staged output must not overwrite the deployed backup")
    with zipfile.ZipFile(deployed_package) as archive:
        entries = archive.infolist()
        if len({entry.filename for entry in entries}) != len(entries):
            raise ValueError("Deployed ZIP contains duplicate member names")
        original = {entry.filename: archive.read(entry.filename) for entry in entries}
        deployed = original[PARSER_MEMBER].decode("utf-8")
        patched, symbols = overlay_parser(deployed, local_bytes.decode("utf-8"))
        deployed_handler = original[HANDLER_MEMBER].decode("utf-8")
        patched_handler = enable_market_ocr(deployed_handler)
        patches = {PARSER_MEMBER: patched.encode("utf-8"), HANDLER_MEMBER: patched_handler.encode("utf-8")}
        with zipfile.ZipFile(package, "w") as output:
            output.comment = archive.comment
            for entry in entries:
                value = patches.get(entry.filename, original[entry.filename])
                output.writestr(entry, value)
    with zipfile.ZipFile(package) as staged:
        if staged.namelist() != [entry.filename for entry in entries]:
            raise ValueError("Staged package changed ZIP membership/order")
        changed = [name for name, content in original.items() if staged.read(name) != content]
    if set(changed) - {PARSER_MEMBER, HANDLER_MEMBER}:
        raise ValueError(f"Unrelated ZIP members changed: {changed}")
    parser_path = output_dir / "market-structure-parser.py"
    parser_path.write_text(patched)
    diff_path = output_dir / "market-structure.diff"
    parser_diff = "".join(difflib.unified_diff(
        deployed.splitlines(True), patched.splitlines(True),
        fromfile="deployed/" + PARSER_MEMBER, tofile="staged/" + PARSER_MEMBER,
    ))
    handler_diff = "".join(difflib.unified_diff(
        deployed_handler.splitlines(True), patched_handler.splitlines(True),
        fromfile="deployed/" + HANDLER_MEMBER, tofile="staged/" + HANDLER_MEMBER,
    ))
    diff_path.write_text(parser_diff + handler_diff)
    manifest = {
        "stageOnly": True,
        "deployedPackage": str(deployed_package.resolve()),
        "deployedPackageSha256": digest(package_bytes),
        "localParserSha256": digest(local_bytes),
        "package": str(package.resolve()),
        "packageSha256": digest(package.read_bytes()),
        "parser": str(parser_path.resolve()),
        "parserSha256": digest(patched.encode("utf-8")),
        "diff": str(diff_path.resolve()),
        "changedFiles": changed,
        "changedSymbols": symbols + ["parse_html_snapshot:market-structure"],
        "unchangedMemberCount": len(original) - len(changed),
        "unrelatedParserAstPreserved": True,
        "unrelatedHandlerAstPreserved": True,
        "handlerChange": "Add market-structure to HTML_TEXTRACT_REPORT_TYPES",
    }
    (output_dir / "stage-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def replay(parser_path, evidence_path, output_path):
    """Replay only file-backed original HTML/images/OCR, with no network access.

    Evidence JSON: htmlPath, receivedAt, messageId, s3Key, optional subject, and
    charts [{url, path, sha256, s3Key, optional id, optional ocrPath}]. A chart
    without cached OCR is retained as a chart but returns no OCR measurements.
    All relative paths resolve against the evidence JSON's directory.
    """
    evidence_path = Path(evidence_path).resolve()
    evidence = json.loads(evidence_path.read_text())
    base = evidence_path.parent
    payloads, responses, archives = {}, {}, {}
    for chart in evidence["charts"]:
        payload = (base / chart["path"]).read_bytes()
        sha256 = digest(payload)
        if sha256 != chart["sha256"]:
            raise ValueError(f"Chart checksum mismatch: {chart['path']}")
        payloads[chart["url"]] = payload
        responses[sha256] = json.loads((base / chart["ocrPath"]).read_text()) if chart.get("ocrPath") else None
        archives[sha256] = {"id": chart.get("id", sha256), "s3Key": chart["s3Key"]}

    class ArchivedTextract:
        def detect_document_text(self, *, Document):
            response = responses[digest(Document["Bytes"])]
            if response is None:
                raise ValueError("No archived OCR response supplied for this chart")
            return response

    def archive_chart(**kwargs):
        if digest(kwargs["payload"]) != kwargs["content_sha256"]:
            raise ValueError("Parser chart checksum mismatch")
        return archives[kwargs["content_sha256"]]

    spec = importlib.util.spec_from_file_location("staged_market_structure_parser", parser_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    candidate = module.parse_html_snapshot(
        report_type="market-structure",
        html_body=(base / evidence["htmlPath"]).read_text(),
        received_at=datetime.fromisoformat(evidence["receivedAt"].replace("Z", "+00:00")),
        s3_key=evidence["s3Key"], message_id=evidence["messageId"],
        subject=evidence.get("subject"), image_fetcher=payloads.__getitem__,
        chart_archiver=archive_chart, textract_client=ArchivedTextract(),
    )
    if not candidate or candidate.get("snapshotType") != "market-structure":
        raise ValueError("Offline replay did not produce a Market Situation snapshot")
    def serialize(value):
        if isinstance(value, Decimal):
            return int(value) if value == value.to_integral_value() else float(value)
        raise TypeError(f"Unsupported JSON value: {type(value).__name__}")
    Path(output_path).write_text(json.dumps(candidate, indent=2, default=serialize) + "\n")
    return candidate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deployed_package", type=Path)
    parser.add_argument("--local-parser", type=Path, default=Path(__file__).resolve().parents[2] / "infra/lambdas/gmail_ingestor" / PARSER_MEMBER)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--replay-evidence", type=Path)
    args = parser.parse_args()
    manifest = stage(args.deployed_package, args.local_parser, args.output_dir)
    if args.replay_evidence:
        candidate_path = args.output_dir / "replayed.snapshot.json"
        candidate = replay(manifest["parser"], args.replay_evidence, candidate_path)
        manifest["candidateSnapshot"] = str(candidate_path.resolve())
        manifest["candidateMetricIds"] = sorted(candidate.get("data", {}).get("chartMetrics", {}))
        manifest["replayEvidence"] = str(args.replay_evidence.resolve())
        manifest["replayWarnings"] = candidate.get("warnings", [])
        (args.output_dir / "stage-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
