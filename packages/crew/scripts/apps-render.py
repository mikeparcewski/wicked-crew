#!/usr/bin/env python3
"""Render an app's standalone fixture for the publish check (CONTRACT-CS2 §P2, §P4).

crew's conformance Python runs this: it serves ``--dir`` on a loopback port with a strict
Content-Security-Policy and drives ``window.__wkFixture`` (§P4) at 1440x900 and 390x844 through headless
Chromium. For every page it screenshots the page before and after changing every filter, and prepares every
action (showing its card). It writes the PNGs and ``report.json`` under ``--out``.

stdlib + playwright only. Exit codes: 0 rendered; 2 bad arguments; 3 no playwright / no browser; 4 a render
error (nothing on the host is wrong, but the fixture did not render). Any non-zero exit means the publish
check answers ``render_unavailable``: it never passes on a render that did not happen.
"""

import argparse
import http.server
import json
import os
import socket
import sys
import threading
import time
import stat
from urllib.parse import urlsplit

VIEWPORTS = [(1440, 900), (390, 844)]
CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
READY_TIMEOUT_MS = 20_000


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="apps-render", add_help=True)
    p.add_argument("--dir", required=True, help="the directory to serve (runtime.js, runtime.css, fixture.html, fixture.js, fixture.json)")
    p.add_argument("--out", required=True, help="where to write the PNGs and report.json")
    return p.parse_args(argv)


ASSETS = {"runtime.js", "runtime.css", "fixture.html", "fixture.js", "fixture.json"}


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serve only immutable asset bytes, opened without following any filesystem links."""

    def do_GET(self):
        name = urlsplit(self.path).path.removeprefix("/")
        data = self.server.assets.get(name)
        if data is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", {"js": "text/javascript", "css": "text/css", "html": "text/html", "json": "application/json"}[name.rsplit(".", 1)[1]])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def _serve(directory):
    # Pin the directory and each regular asset by descriptor before starting the server. No listings,
    # out/ files, URL decoding tricks, or symlinks are ever served, even if entries change later.
    assets = {}
    root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in ASSETS:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
            with os.fdopen(fd, "rb") as fh:
                info = os.fstat(fh.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError(f"{name} is not a private regular asset")
                assets[name] = fh.read()
    finally:
        os.close(root)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.assets = assets
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, httpd.server_address[1]


def _collect(page, errors):
    for error in page.evaluate("window.__wkFixture.errors || []"):
        message = f"fixture: {error}"
        if message not in errors:
            errors.append(message)


def _drive(page, origin, width, out_dir, report, fixture):
    """Every awaited interaction is checked, including readiness and the last card close."""
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    try:
        page.goto(f"{origin}/fixture.html", wait_until="load")
        deadline = time.monotonic() + READY_TIMEOUT_MS / 1000.0
        while not page.evaluate("!!(window.__wkFixture && window.__wkFixture.ready === true)"):
            if time.monotonic() >= deadline:
                errors.append(f"the runtime did not become ready at {width}")
                return
            time.sleep(0.1)
        _collect(page, errors)
        pages = [p["id"] for p in fixture["spec"]["pages"]]
        if page.evaluate("window.__wkFixture.pages()") != pages or not pages:
            raise ValueError("the runtime did not expose every declared page")
        declared = [a["id"] for a in fixture["spec"]["actions"]]
        if set(declared) != set(fixture["cards"]):
            raise ValueError("the fixture does not have every declared action card")
        prepared = set()

        def prepare(page_id, action_id):
            if action_id not in declared:
                raise ValueError(f"unknown action {action_id}")
            page.evaluate("async (a) => window.__wkFixture.prepare(a)", action_id)
            _snap(page, page_id, width, out_dir, report, errors, note="action", action=action_id)
            report["actions"].append({"page": page_id, "id": action_id, "width": width})
            prepared.add(action_id)
            page.evaluate("async () => window.__wkFixture.closeCard()")
            _collect(page, errors)

        for page_id in pages:
            page.evaluate("async (p) => window.__wkFixture.show(p)", page_id)
            _snap(page, page_id, width, out_dir, report, errors, note="page")
            filters = page.evaluate("(p) => window.__wkFixture.filters(p)", page_id)
            expected = {c["id"] for c in next(p for p in fixture["spec"]["pages"] if p["id"] == page_id)["components"] if c["type"] == "filter"}
            if {f["id"] for f in filters} != expected:
                raise ValueError(f"the runtime did not expose every filter of {page_id}")
            for f in filters:
                if not f.get("values"):
                    raise ValueError(f"filter {f['id']} has no fixture values")
                for value in f["values"]:
                    page.evaluate("async (a) => window.__wkFixture.setFilter(a.id, a.value)", {"id": f["id"], "value": value})
                    _snap(page, page_id, width, out_dir, report, errors, note="filter", filter=f["id"], value=value)
                    report["filters"].append({"page": page_id, "id": f["id"], "value": value, "width": width})
            for action_id in page.evaluate("(p) => window.__wkFixture.actions(p)", page_id):
                prepare(page_id, action_id)
        # A declared action need not have a button on any page. Its card still needs evidence.
        for action_id in declared:
            if action_id not in prepared:
                prepare(pages[-1], action_id)
        _collect(page, errors)
    except Exception as exc:
        errors.append(str(exc))
    finally:
        report["errors"].extend(errors)


def _snap(page, page_id, width, out_dir, report, errors, note, **detail):
    _collect(page, errors)
    # Indices are bounded, unique lowercase ASCII regardless of page ids or filter values.
    shot = f"shot-{len(report['pages']):06d}-{width}.png"
    page.screenshot(path=os.path.join(out_dir, shot))
    report["pages"].append({"page": page_id, "width": width, "shot": shot, "note": note, **detail, "errors": list(errors)})


def main(argv):
    try:
        args = _parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0

    for name in ASSETS:
        if not os.path.isfile(os.path.join(args.dir, name)):
            print(f"apps-render: {args.dir} has no {name}", file=sys.stderr)
            return 2

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        print(f"apps-render: playwright is not available: {exc}", file=sys.stderr)
        return 3

    os.makedirs(args.out, exist_ok=True)
    report = {"pages": [], "filters": [], "actions": [], "errors": []}
    try:
        httpd, port = _serve(args.dir)
        with open(os.path.join(args.dir, "fixture.json"), encoding="utf-8") as fh:
            fixture = json.load(fh)
    except Exception as exc:
        print(f"apps-render: unsafe or unreadable fixture: {exc}", file=sys.stderr)
        return 2
    origin = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(args=["--no-sandbox"])
            except Exception as exc:  # noqa: BLE001
                print(f"apps-render: could not launch Chromium: {exc}", file=sys.stderr)
                return 3
            try:
                for width, height in VIEWPORTS:
                    context = browser.new_context(viewport={"width": width, "height": height})
                    context.set_default_timeout(READY_TIMEOUT_MS)
                    page = context.new_page()
                    try:
                        _drive(page, origin, width, args.out, report, fixture)
                    finally:
                        context.close()
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001
        report["errors"].append(str(exc))
    finally:
        httpd.shutdown()

    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh)

    if report["errors"]:
        print(f"apps-render: {len(report['errors'])} render error(s): {'; '.join(report['errors'])[:1000]}", file=sys.stderr)
        return 4
    if not report["pages"]:
        print("apps-render: no page rendered", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    # A loopback socket on a host with no network still binds; a truly blocked loopback is a render error.
    try:
        socket.socket(socket.AF_INET, socket.SOCK_STREAM).close()
    except OSError as exc:  # noqa: BLE001
        print(f"apps-render: no loopback socket: {exc}", file=sys.stderr)
        sys.exit(4)
    sys.exit(main(sys.argv[1:]))
