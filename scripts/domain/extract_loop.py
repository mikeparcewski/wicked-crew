#!/usr/bin/env python3
"""extract_loop.py — deterministic extraction harness for wicked-crew.

Adapted from the garden version for wicked-estate 0.12.0:

  * No ``wicked-core coverage`` call — the worklist is seeded from the
    existing ``wicked-estate.coverage.json`` (the same authority the coverage
    gate consults).  Re-derivation on each loop iteration checks annotations
    directly in the estate store.
  * No ``semantics`` command — ``set_requirement`` is a no-op in this estate
    version; coverage is tracked by annotation type (``business_rule`` /
    ``risk``).

RISK-FLOOR INVARIANT — every worklist node terminates RESOLVED-or-RISK.  A
model timeout / omission / invalid return is FORCED to RISK, never dropped, so
coverage reaches 1.0 deterministically; the model only upgrades RISK->RESOLVED
quality.

``--dry-run`` swaps the model for a deterministic stub (zero model cost).

stdlib-only, cross-platform.  Exits 0 when the pass completes within budget;
non-zero only on a genuine harness failure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # scripts/ on path

from domain import _clients, _rule_extractor  # noqa: E402

RESOLVE_THRESHOLD = 0.75


def _cohesion(sid: str, node_community: dict[str, str],
              community_sizes: dict[str, int]) -> float:
    """Cheap structural cohesion signal.  Bounded [0.85, 1.1]."""
    label = node_community.get(sid, sid)
    size = community_sizes.get(label, 1)
    if label == sid or size <= 1:
        return 0.85
    return min(1.1, 0.95 + 0.03 * size)


def _stub_rule(node: dict) -> dict:
    """Deterministic no-model rule for ``--dry-run`` mode."""
    name = node.get("name", "unit")
    return {
        "symbol_id": node["symbol_id"],
        "statement": f"{name} performs its documented behavior as implemented",
        "confidence": 0.9,
        "provenance": {
            "source": "extract-loop:dry-run",
            "ref": node["symbol_id"],
            "source_kinds": ["code-body"],
        },
    }


def _write_node(estate: _clients.CliEstateClient, sid: str, name: str,
                rule: dict | None, resolved: bool, reason: str) -> None:
    """The two coordinated writes + read-back (vault record+verify).

    RESOLVED -> business_rule annotation + set_requirement(validated=True).
    RISK      -> risk annotation + set_requirement(validated=False).
    Either way the node is ACCOUNTED (RISK-floor guarantees completeness).
    """
    rid = "RULE-%s" % hashlib.sha256(sid.encode()).hexdigest()[:12]
    if resolved and rule:
        stmt = rule["statement"]
        estate.annotate(sid, type="business_rule", key=rid, value=stmt,
                        confidence=float(rule.get("confidence", 0.9)),
                        provenance=str(rule.get("provenance", {}).get("source",
                                                                       "extract-loop")),
                        replace=True)
        estate.set_requirement(sid, requirement=stmt, validated=True)
    else:
        stmt = (rule or {}).get("statement") or ""
        risk_req = f"[RISK] {name}: {reason}" + (f" — {stmt}" if stmt else "")
        estate.annotate(sid, type="risk", key=rid, value=risk_req[:500],
                        confidence=float((rule or {}).get("confidence", 0.0)),
                        provenance="extract-loop:risk", replace=True)
        estate.set_requirement(sid, requirement=risk_req, validated=False)
    # Read-back: verify the write is durable.
    anns = estate.read_annotations(sid)
    if not any(a.get("key") == rid for a in anns):
        raise RuntimeError(
            f"write not durable: {sid} missing annotation {rid} on read-back"
        )


def _update_coverage_json(coverage_path: str, newly_accounted: int,
                          newly_resolved: int) -> None:
    """Update the coverage JSON file with new counts after a pass."""
    path = Path(coverage_path)
    if not path.exists():
        return
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return

    old_unaccounted = int(doc.get("unaccounted", 0))
    old_resolved = int(doc.get("resolved", 0))
    old_risk = int(doc.get("risk_flagged", 0))
    behavior_bearing = int(doc.get("behavior_bearing", 1))
    threshold = float(doc.get("resolve_threshold", 0.75))

    new_unaccounted = max(0, old_unaccounted - newly_accounted)
    new_risk = old_risk + (newly_accounted - newly_resolved)
    new_resolved = old_resolved + newly_resolved

    # Remove the nodes we just annotated from unaccounted_nodes list.
    nodes_list = doc.get("unaccounted_nodes", [])
    # (We don't have a precise per-node list here, so leave it; the loop re-derives
    # it by checking annotations directly on the next pass.)

    doc["unaccounted"] = new_unaccounted
    doc["risk_flagged"] = new_risk
    doc["resolved"] = new_resolved
    doc["coverage"] = round(
        (new_resolved + new_risk) / max(behavior_bearing, 1), 4
    )
    doc["resolved_rate"] = round(new_resolved / max(behavior_bearing, 1), 4)

    try:
        path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    except OSError:
        pass  # best-effort


def run(db: str, coverage_path: str, *, time_budget: float, limit: int,
        batch: int, dry_run: bool, project_dir: Path | None = None) -> int:
    if not db:
        raise RuntimeError("--db / $WICKED_ESTATE_DB is required")
    estate = _clients.estate_client(db=db, project_dir=project_dir)
    model_argv = None if dry_run else _clients.rule_model_argv(project_dir)
    if not dry_run and model_argv is None:
        raise RuntimeError(
            "no rule model resolvable (set WICKED_RULE_MODEL_BIN or install claude); "
            "use --dry-run for the deterministic stub"
        )

    deadline = time.monotonic() + time_budget

    # Cohesion framing (quality signal only — best-effort).
    try:
        clusters = estate.read_clusters()
        all_nodes = estate.list_nodes()
        node_community = _clients.total_node_community(clusters, all_nodes)
        community_sizes: dict[str, int] = {}
        for lbl in node_community.values():
            community_sizes[lbl] = community_sizes.get(lbl, 0) + 1
    except Exception as e:
        print(f"[extract-loop] cohesion framing unavailable ({e}); proceeding singleton-flat",
              file=sys.stderr)
        node_community, community_sizes = {}, {}

    # Seed the initial worklist from the coverage file.
    initial_worklist = _clients.unaccounted_nodes_from_file(coverage_path)
    print(f"[extract-loop] seeded {len(initial_worklist)} unaccounted nodes from coverage file",
          file=sys.stderr)

    # Read behavior_bearing from the coverage file for accurate coverage reporting.
    try:
        _cov_doc = json.loads(Path(coverage_path).read_text(encoding="utf-8"))
        behavior_bearing = int(_cov_doc.get("behavior_bearing", max(len(initial_worklist), 1)))
        _initial_risk = int(_cov_doc.get("risk_flagged", 0))
        _initial_resolved = int(_cov_doc.get("resolved", 0))
    except Exception:
        behavior_bearing = max(len(initial_worklist), 1)
        _initial_risk = 0
        _initial_resolved = 0

    processed = 0
    newly_accounted = 0
    newly_resolved = 0
    processed_ids: set[str] = set()  # track session progress (not annotation state)

    while True:
        # Re-derive worklist: nodes from the initial seed not yet processed this session.
        # Session tracking (not annotation state) avoids confusing stub/prior annotations
        # with "accounted" — a node is only considered done when THIS run wrote to it.
        worklist = [n for n in initial_worklist
                    if n.get("symbol_id") not in processed_ids]

        accounted_total = _initial_risk + _initial_resolved + newly_accounted
        coverage_pct = min(1.0, accounted_total / max(behavior_bearing, 1))
        print(f"[extract-loop] coverage={coverage_pct:.4f} unaccounted={len(worklist)} "
              f"processed={processed}", file=sys.stderr)

        if not worklist:
            print("[extract-loop] coverage 1.0 — every behavior-bearing node accounted",
                  file=sys.stderr)
            _update_coverage_json(coverage_path, newly_accounted, newly_resolved)
            return 0

        if time.monotonic() >= deadline or (limit and processed >= limit):
            print(f"[extract-loop] budget reached (processed={processed}); "
                  f"{len(worklist)} unaccounted remain — resume with another pass",
                  file=sys.stderr)
            _update_coverage_json(coverage_path, newly_accounted, newly_resolved)
            return 0

        # Take a bounded slice.
        take = worklist[:batch]
        if limit:
            take = take[:max(0, limit - processed)]

        # Frame each node with its source slice.
        framed, ids = [], set()
        for n in take:
            sid, name = n["symbol_id"], n.get("name", "")
            try:
                slice_txt = estate.source(sid)[:4000] if not dry_run else ""
            except Exception:
                slice_txt = ""
            framed.append(_rule_extractor.frame_context(
                n, slice_txt,
                cluster_label=node_community.get(sid),
                neighbor_names=[],
            ))
            ids.add(sid)

        # Model boundary (or dry-run stub).
        by_id: dict[str, dict] = {}
        if dry_run:
            by_id = {n["symbol_id"]: _stub_rule(n) for n in take}
        else:
            try:
                for r in _rule_extractor.extract_rules(framed, model_argv):
                    if isinstance(r, dict) and r.get("symbol_id") in ids:
                        by_id[r["symbol_id"]] = r
            except Exception as e:
                print(f"[extract-loop] model batch failed ({e}); RISK-flooring the batch",
                      file=sys.stderr)

        # Deterministic write per node — RISK-FLOOR: every node terminates.
        for n in take:
            sid, name = n["symbol_id"], n.get("name", "")
            rule = by_id.get(sid)
            ok, reason = (_rule_extractor.validate_rule(rule, ids) if rule
                          else (False, "no rule returned for this node"))
            if ok:
                adjusted = float(rule["confidence"]) * _cohesion(
                    sid, node_community, community_sizes
                )
                resolved = adjusted >= RESOLVE_THRESHOLD
                _write_node(estate, sid, name, rule, resolved,
                            "below confidence threshold" if not resolved else "")
                if resolved:
                    newly_resolved += 1
            else:
                _write_node(estate, sid, name, rule, False, reason)
            newly_accounted += 1
            processed_ids.add(sid)
            processed += 1


def main(argv: list[str] | None = None) -> int:
    import os
    ap = argparse.ArgumentParser(
        description="Deterministic extraction harness for wicked-crew (estate 0.12.0)."
    )
    ap.add_argument(
        "--db", default=os.environ.get("WICKED_ESTATE_DB"),
        help="estate store path (default: $WICKED_ESTATE_DB)",
    )
    ap.add_argument(
        "--coverage", default=None,
        help="path to wicked-estate.coverage.json (default: <db>.coverage.json)",
    )
    ap.add_argument("--time-budget", type=float, default=780.0,
                    help="seconds this pass may run (default 780)")
    ap.add_argument("--limit", type=int, default=0,
                    help="max nodes this pass (0 = unbounded within time budget)")
    ap.add_argument("--batch", type=int, default=12,
                    help="framed nodes per model call")
    ap.add_argument("--dry-run", action="store_true",
                    help="deterministic stub instead of the model")
    args = ap.parse_args(argv)
    if not args.db:
        ap.error("--db is required (or set $WICKED_ESTATE_DB)")
    coverage_path = args.coverage or str(Path(args.db).with_suffix(".coverage.json"))
    return run(
        args.db, coverage_path,
        time_budget=args.time_budget,
        limit=args.limit,
        batch=args.batch,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    raise SystemExit(main())
