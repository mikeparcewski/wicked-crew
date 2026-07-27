#!/usr/bin/env python3
"""Re-verify: Burn panel populates from the usage fix; Cov modal opens via its X-close path."""
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

    roster = api("/roster")["roster"]
    claude = [c for c in roster if c["key"] == "claude"]
    run_id = api(
        "/runs",
        {
            "problem": "Burn verification: reply with the single word burn-ok",
            "clisJson": json.dumps(claude),
        },
    )["runId"]
    report["run_id"] = run_id
    page.goto(f"{BASE}/runs/{run_id}", wait_until="networkidle")

    deadline = time.time() + 420
    while time.time() < deadline:
        if api(f"/runs/{run_id}")["run"]["session"]["status"] in ("completed", "failed", "cancelled"):
            break
        page.wait_for_timeout(4000)
    page.wait_for_timeout(2500)

    # Open Burn.
    btn = page.locator('button[aria-expanded]:has-text("Burn")').first
    btn.click()
    page.wait_for_timeout(900)
    page.screenshot(path=str(OUT / "30-burn-after-fix.png"))
    report["burn_text"] = page.evaluate(
        """() => {
            const b = Array.from(document.querySelectorAll('button[aria-expanded="true"]'))
                .find(x => x.innerText.includes('Burn'));
            const panel = b?.parentElement?.querySelector('div:not(:first-child)');
            return (panel?.innerText ?? '').slice(0, 600);
        }"""
    )

    # Cov modal — click, screenshot, close via the X (Escape is disabled by design on Term).
    cov = page.locator('button[aria-label="Open coverage report"]').first
    report["cov_found"] = cov.count() > 0
    if report["cov_found"]:
        cov.click()
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / "31-cov-modal.png"))
        close = page.locator('div.fixed button[aria-label*="lose"], div.fixed button:has-text("✕"), div.fixed button:has-text("×")').first
        if close.count() > 0:
            close.click()
            report["cov_closed_via_x"] = True
        else:
            # The X-close path IS the assertion — a missing button is a failure.
            report["cov_closed_via_x"] = False
        page.wait_for_timeout(600)

    browser.close()

json.dump(report, sys.stdout, indent=1, default=str)
