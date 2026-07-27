#!/usr/bin/env python3
"""Full insight-rail verification:
1. open studio, launch a run via the API, navigate to it while it executes
2. hold the page open so WS events populate the panels (no replay on late join)
3. after completion, open every accordion + Term + Cov, screenshot, dump text
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("STUDIO_URL", "http://127.0.0.1:4200")
API = os.environ.get("CREW_API", "http://127.0.0.1:7701/api/v1")
OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)

ACCORDIONS = [
    ("whatwhere", "What / Where"),
    ("decisions", "Decisions"),
    ("governance", "Governance"),
    ("burn", "Burn"),
    ("data", "Data"),
    ("steering", "Steering"),
    ("assumptions", "Assumptions"),
    ("files", "Files"),
]

report = {}


def api(path, data=None):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(data).encode() if data else None,
        headers={"Content-Type": "application/json"},
        method="POST" if data else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1680, "height": 1000})
    page.goto(BASE, wait_until="networkidle")
    page.wait_for_timeout(1500)

    # Launch a claude-only run (no gates) while the page's WS is live.
    roster = api("/roster")["roster"]
    claude = [c for c in roster if c["key"] == "claude"]
    run_id = api(
        "/runs",
        {
            "problem": "Insight rail test: summarize what a governance gate does in two sentences",
            "clisJson": json.dumps(claude),
        },
    )["runId"]
    report["run_id"] = run_id

    page.goto(f"{BASE}/runs/{run_id}", wait_until="networkidle")

    # Hold the page open until the run completes (WS events populate the model).
    deadline = time.time() + 420
    status = "unknown"
    while time.time() < deadline:
        status = api(f"/runs/{run_id}")["run"]["session"]["status"]
        if status in ("completed", "failed", "cancelled"):
            break
        page.wait_for_timeout(4000)
    report["final_status"] = status
    page.wait_for_timeout(2500)
    page.screenshot(path=str(OUT / "10-run-complete.png"))

    # Walk every accordion via its aria-expanded button (labels are unique in the rail).
    for i, (aid, label) in enumerate(ACCORDIONS, start=11):
        entry = {}
        try:
            btn = page.locator(f'button[aria-expanded]:has-text("{label}")').first
            entry["found"] = btn.count() > 0
            if entry["found"]:
                btn.click()
                page.wait_for_timeout(800)
                page.screenshot(path=str(OUT / f"{i:02d}-{aid}.png"))
                panel_text = page.evaluate(
                    """(label) => {
                        const btns = Array.from(document.querySelectorAll('button[aria-expanded="true"]'));
                        const b = btns.find(x => x.innerText.includes(label));
                        const panel = b?.parentElement?.querySelector('div:not(:first-child)');
                        return (panel?.innerText ?? b?.parentElement?.innerText ?? '').slice(0, 900);
                    }""",
                    label,
                )
                entry["text"] = panel_text
        except Exception as e:  # noqa: BLE001
            entry["error"] = str(e)
        report[aid] = entry

    # Term (terminal drawer) and Cov (coverage overlay).
    for j, (name, aria) in enumerate(
        [("term", "Term"), ("cov", "Open coverage report")], start=19
    ):
        entry = {}
        try:
            btn = (
                page.locator(f'button[aria-label="{aria}"]').first
                if name == "cov"
                else page.locator('button:has-text("Term")').last
            )
            entry["found"] = btn.count() > 0
            if entry["found"]:
                btn.click()
                page.wait_for_timeout(1500)
                page.screenshot(path=str(OUT / f"{j:02d}-{name}.png"))
                # Close overlays with Escape so the next step starts clean.
                page.keyboard.press("Escape")
                page.wait_for_timeout(500)
        except Exception as e:  # noqa: BLE001
            entry["error"] = str(e)
        report[name] = entry

    browser.close()

json.dump(report, sys.stdout, indent=1, default=str)
