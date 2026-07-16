"""CLI-backed clients for the domain-extractor harness — wicked-crew edition.

Adapted for wicked-estate 0.12.0, which differs from the garden version used
in extract_loop (garden targets 0.13.0+):

  * No ``resolve`` subcommand — not needed; SymbolIds come directly from the
    coverage report's ``unaccounted_nodes``.
  * No ``semantics`` subcommand — ``set_requirement`` is a no-op with a warning;
    coverage is tracked by annotation type (``business_rule`` / ``risk``) only.
  * ``source <name>`` does a name-search, not SymbolId lookup — we use
    ``source --symbols <id> --json`` and extract the ``nodes[0].source`` field.

No ``CliCoreClient``: the wicked-core binary here (wicked-crew dev build) does
not expose ``coverage`` or ``domain-graph`` subcommands. Coverage is re-derived
from the ``wicked-estate.coverage.json`` file that already exists in the repo
and is updated by ``extract_loop.py`` after each pass.

Cross-platform: argv lists via :mod:`subprocess` (never ``shell=True``);
``shutil.which`` for resolution; stdlib only.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Binary resolution (env var > PATH > node_modules/.bin)
# ---------------------------------------------------------------------------

_DEFAULT_TIMEOUT = 120


def _resolve_bin(env_var: str, package: str,
                 project_dir: Optional[Path] = None) -> Optional[list[str]]:
    """Resolve the argv prefix for ``package``.

    Ladder (first hit wins):
      1. ``env_var`` env. Set-but-empty is the kill-switch -> None.
      2. ``package`` on PATH (shutil.which).
      3. project-local ``node_modules/.bin/<package>``.
      else None.
    """
    if env_var in os.environ:
        val = os.environ[env_var].strip()
        return [val] if val else None
    found = shutil.which(package)
    if found:
        return [found]
    base = Path(project_dir) if project_dir else Path.cwd()
    local = base / "node_modules" / ".bin" / package
    if local.exists():
        return [str(local)]
    return None


def _invoke(argv: list[str]) -> subprocess.CompletedProcess:
    """Run ``argv`` bounded and fail-loud."""
    try:
        return subprocess.run(
            argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
            stdin=subprocess.DEVNULL, timeout=_DEFAULT_TIMEOUT,
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"{argv[0]} not found or not executable: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"{argv[0]} exceeded {_DEFAULT_TIMEOUT}s: {argv[1:]!r}") from e
    except (ValueError, OSError) as e:
        raise RuntimeError(f"{argv[0]} could not be executed: {e}") from e


def _run_json(argv: list[str]) -> Any:
    proc = _invoke(argv)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{argv[0]} exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"{argv[0]} produced no output for {argv[1:]!r}")
    try:
        return json.loads(out)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{argv[0]} output is not JSON: {e}: {out[:200]!r}") from e


def _run(argv: list[str]) -> str:
    proc = _invoke(argv)
    if proc.returncode != 0:
        raise RuntimeError(
            f"{argv[0]} exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout


def _looks_like_symbol_id(value: str) -> bool:
    """A real estate SymbolId has structural separators a bare name never does."""
    if not isinstance(value, str) or not value.strip():
        return False
    return "::" in value or " . . . " in value or "/" in value


# ---------------------------------------------------------------------------
# CliEstateClient — estate 0.12.0 surface
# ---------------------------------------------------------------------------

class CliEstateClient:
    """Shells ``wicked-estate`` 0.12.0 for the extraction surface.

    Key 0.12.0 differences vs the garden version:
      * ``annotate`` uses ``<name>`` positional, but ``--symbol <id>`` is
        also supported and REQUIRED here to avoid name-fan-out.
      * ``source --symbols <id> --json`` returns ``{nodes:[{source,...}]}``
        — we extract ``nodes[0]["source"]``.
      * ``semantics`` does not exist — ``set_requirement`` is a no-op.
      * ``resolve`` does not exist — the caller must already hold SymbolIds
        (they come from the coverage report's ``unaccounted_nodes``).
    """

    def __init__(self, bin_argv: list[str], db: str):
        self._bin = list(bin_argv)
        self._db = db

    def _argv(self, *parts: str) -> list[str]:
        return [*self._bin, *parts, "--db", self._db]

    # -- read --

    def read_clusters(self, params: dict | None = None) -> list[dict[str, Any]]:
        argv = [*self._bin, "clusters"]
        if params and params.get("min") is not None:
            argv.append(str(int(params["min"])))
        argv += ["--json", "--summary", "--db", self._db]
        data = _run_json(argv)
        if not isinstance(data, list):
            raise RuntimeError(
                f"wicked-estate clusters returned {type(data).__name__}, expected list"
            )
        return data

    def list_nodes(self) -> list[dict[str, Any]]:
        """Every node in the store (``nodes --json``) — for cohesion framing."""
        data = _run_json(self._argv("nodes", "--json"))
        if not isinstance(data, list):
            raise RuntimeError(
                f"wicked-estate nodes returned {type(data).__name__}, expected list"
            )
        return data

    def source(self, symbol_id: str) -> str:
        """Source slice for a SymbolId via ``source --symbols <id> --json``.

        Falls back to an empty string (best-effort) rather than raising, so a
        missing slice degrades the quality signal, not the loop.
        """
        if not _looks_like_symbol_id(symbol_id):
            return ""
        try:
            data = _run_json(self._argv("source", "--symbols", symbol_id, "--json"))
            nodes = data.get("nodes", []) if isinstance(data, dict) else []
            if nodes and isinstance(nodes[0], dict):
                return nodes[0].get("source", "") or ""
        except Exception:
            pass
        return ""

    def read_annotations(self, symbol_id: str) -> list[dict[str, Any]]:
        if not _looks_like_symbol_id(symbol_id):
            raise ValueError(
                f"refusing read_annotations on non-SymbolId {symbol_id!r}"
            )
        data = _run_json(self._argv("annotations", "--symbol", symbol_id, "--json"))
        if not isinstance(data, dict):
            raise RuntimeError(
                f"wicked-estate annotations --symbol returned {type(data).__name__}, "
                "expected single-symbol object"
            )
        anns = data.get("annotations")
        if not isinstance(anns, list):
            raise RuntimeError(
                f"wicked-estate annotations: 'annotations' is {type(anns).__name__}, "
                "expected list"
            )
        return anns

    # -- write --

    def annotate(self, symbol_id: str, type: str, key: str, value: str,
                 confidence: float | None = None, provenance: str | None = None,
                 replace: bool = True) -> None:
        if not _looks_like_symbol_id(symbol_id):
            raise ValueError(
                f"refusing annotate on non-SymbolId {symbol_id!r} — resolve first"
            )
        argv = self._argv("annotate", "--symbol", symbol_id,
                          "--type", type, "--key", key, "--value", value)
        if confidence is not None:
            argv += ["--confidence", repr(float(confidence))]
        if provenance is not None:
            argv += ["--provenance", provenance]
        if replace:
            argv.append("--replace")
        _run(argv)

    def set_requirement(self, symbol_id: str, requirement: str,
                        validated: bool) -> None:
        """No-op: ``wicked-estate 0.12.0`` has no ``semantics`` subcommand.

        Coverage is tracked via annotation type (``business_rule`` / ``risk``).
        This method is called for compatibility with the garden harness interface
        but has no effect on the 0.12.0 estate.
        """
        import sys
        print(
            f"[extract-loop] set_requirement skipped (no semantics cmd): {symbol_id[:60]!r}",
            file=sys.stderr,
        )

    def find_by_annotation(self, key: str, value: str | None = None) -> list[str]:
        raise NotImplementedError(
            "find_by_annotation is not available on the CLI-backed estate client"
        )


# ---------------------------------------------------------------------------
# Coverage worklist (from file — no wicked-core coverage command)
# ---------------------------------------------------------------------------

def unaccounted_nodes_from_file(coverage_path: str) -> list[dict[str, Any]]:
    """Load the extraction worklist from an existing coverage JSON file.

    The ``unaccounted_nodes`` list is the authoritative source — the same
    authority a future ``wicked-core coverage`` call would re-derive.  Fail-loud
    if the key is absent or malformed so a silent ``[]`` never looks like
    "nothing to do".
    """
    path = Path(coverage_path)
    if not path.exists():
        raise RuntimeError(f"coverage file not found: {coverage_path!r}")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        raise RuntimeError(f"cannot read coverage file {coverage_path!r}: {e}") from e
    if "unaccounted_nodes" not in doc:
        raise RuntimeError(
            f"coverage file {coverage_path!r} has no 'unaccounted_nodes' key — "
            "cannot seed the extraction worklist"
        )
    nodes = doc["unaccounted_nodes"]
    if not isinstance(nodes, list):
        raise RuntimeError(
            f"'unaccounted_nodes' is {type(nodes).__name__}, expected list"
        )
    return nodes


def filter_still_unaccounted(
    nodes: list[dict[str, Any]], estate: CliEstateClient
) -> list[dict[str, Any]]:
    """Re-derive the remaining worklist by checking which nodes from ``nodes``
    still lack a ``business_rule`` or ``risk`` annotation.  This replaces the
    ``wicked-core coverage`` re-derivation call in the garden harness."""
    remaining = []
    for n in nodes:
        sid = n.get("symbol_id", "")
        if not _looks_like_symbol_id(sid):
            remaining.append(n)
            continue
        try:
            anns = estate.read_annotations(sid)
            types = {a.get("type", "") for a in anns if isinstance(a, dict)}
            if "business_rule" not in types and "risk" not in types:
                remaining.append(n)
        except Exception:
            # Read failed — keep it in the worklist (fail-safe)
            remaining.append(n)
    return remaining


def total_node_community(clusters: list[dict[str, Any]],
                         all_nodes: list[dict[str, Any]]) -> dict[str, str]:
    """Map every node to a community label (singleton-assign the rest)."""
    node_community: dict[str, str] = {}
    for comm in clusters:
        members = sorted(str(m) for m in comm.get("members", []))
        if not members:
            continue
        label = members[0]
        for sid in members:
            node_community[sid] = label
    for n in all_nodes:
        sid = n.get("symbol_id")
        if sid and sid not in node_community:
            node_community[sid] = sid
    return node_community


# ---------------------------------------------------------------------------
# Rule model resolution
# ---------------------------------------------------------------------------

RULE_MODEL_ENV = "WICKED_RULE_MODEL_BIN"
ESTATE_ENV = "WICKED_ESTATE_BIN"


def rule_model_argv(project_dir: Optional[Path] = None) -> Optional[list[str]]:
    """Resolve the per-node rule model CLI.  Default: ``claude -p``."""
    if RULE_MODEL_ENV in os.environ:
        val = os.environ[RULE_MODEL_ENV].strip()
        return val.split() if val else None
    found = shutil.which("claude")
    return [found, "-p"] if found else None


def estate_client(db: Optional[str] = None,
                  project_dir: Optional[Path] = None) -> CliEstateClient:
    """A CLI-backed :class:`CliEstateClient` (no mock fallback — estate is required)."""
    bin_argv = _resolve_bin(ESTATE_ENV, "wicked-estate", project_dir)
    if not bin_argv:
        raise RuntimeError(
            "wicked-estate not resolvable — set WICKED_ESTATE_BIN or install it on PATH"
        )
    if not db:
        raise RuntimeError("estate_client: db path is required")
    return CliEstateClient(bin_argv, db)
