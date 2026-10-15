"""Present a Balance post from its own verified, captured current account."""
from review_runs_v2 import canonical_fingerprint, render_review


def attach_balance_primary(conversation, store):
    if conversation.get("kind") != "balance-review" or not conversation.get("id"):
        return conversation
    message = next((row for row in reversed(conversation.get("messages") or [])
                    if row.get("role") == "assistant" and not row.get("reviewNarrative")
                    and row.get("reviewRunId") and row.get("reviewPostId")), None)
    if not message:
        return conversation
    run = store.get(message["reviewRunId"])
    if (not run or run.get("conversationId") != conversation["id"]
            or run.get("reviewKind") != "balance-review" or run.get("state") not in {"running", "succeeded"}):
        return conversation
    evidence = store.read_evidence(run, "balance")
    evidence = evidence if isinstance(evidence, dict) else {}
    data = evidence.get("data")
    current = data.get("current") if isinstance(data, dict) else None
    current = current if isinstance(current, dict) else {}
    bad_flags = ("stale", "cached", "cacheOnly", "fromCache", "from_cache", "mock",
                 "seed", "seeded", "synthetic", "fallback", "inferred", "portfolioDerived",
                 "offline", "disconnected", "refreshFailed")
    available = bool(
        ((run.get("dependencies") or {}).get("balance") or {}).get("status") in {"ready", "partial"}
        and evidence.get("liveVerified") is True
        and not any(source.get(flag) is True for source in (evidence, current) for flag in bad_flags)
        and all(source.get("connected") is not False for source in (evidence, current))
        and current.get("available") is True and current.get("status") == "live"
        and current.get("source") == "ibkr_live_session" and current.get("fromCache") is False
    )
    fingerprint = ((run.get("sourceFingerprints") or {}).get("balance")
                   or ((run.get("dependencies") or {}).get("balance") or {}).get("fingerprint")) if evidence else None
    message["balancePrimary"] = {
        "runId": run["runId"], "available": available,
        "reportRevision": canonical_fingerprint({"reportRevision": run.get("reportRevision"),
                                                 "verifiedBalanceFingerprint": fingerprint, "available": available}),
        "asOf": current.get("observedAt") if available else None,
    }
    message["balancePrimaryIncluded"] = True
    if available:
        # Before the first Node frame, the durable current checkpoint can
        # already render the same primary using the established formatter.
        report = run.get("reportMarkdown") or render_review("balance-review", [{
            "id": "account-summary", "status": "ready", "reasonCode": "VERIFIED", "current": current,
        }], "partial", [])
        message["text"] = report if run.get("reportMarkdown") else "\n".join(
            line for line in report.splitlines() if line.strip() != "No issues detected."
        ).strip() + "\n"
        message["citations"] = run.get("citations") or []
    elif run.get("state") == "running":
        message["text"] = ""
        message["citations"] = []
    else:
        message["text"] = "Balance evidence unavailable."
        message["citations"] = []
    return conversation
