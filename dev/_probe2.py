"""Why does the interval never retrigger? Dump the beacons the client sent."""

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HARNESS = (Path(__file__).resolve().parent / "harness" / "index.html")


def chrome_path():
    root = Path.home() / "AppData" / "Local" / "ms-playwright"
    for candidate in sorted(root.glob("chromium-*/chrome-win/chrome.exe"), reverse=True):
        return str(candidate)
    return None


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=chrome_path())
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(HARNESS.as_uri(), wait_until="domcontentloaded")
    page.wait_for_function("() => window.__harnessReady === true", timeout=30000)

    def h(expr):
        return page.evaluate(f"() => window.__harness.{expr}")

    h("resetMetrics()")
    h("type('')")
    h("setComposeTiming({first: 3200, step: 300})")
    for burst in ["第一段快速输入", "第二段继续补充", "第三段再加一句"]:
        h(f"typeLive({json.dumps(burst)}, {{delay: 55}})")
        page.wait_for_timeout(700)
    page.wait_for_timeout(6000)

    store = h("store()") or {}
    print(f"store: phase={store.get('phase')} items={len(store.get('items') or [])} forDraft={len(store.get('forDraft') or '')}")
    calls = h("calls")
    print(f"calls: {len(calls)}，按类型统计：")
    kinds = {}
    for call in calls:
        key = call["mode"] if call["mode"] != "beacon" else f"beacon:{call['event'] or call['detail'][:24]}"
        kinds[key] = kinds.get(key, 0) + 1
    for key, count in sorted(kinds.items(), key=lambda item: -item[1]):
        print(f"  {key:<34} {count}")
    print("draft length:", len(h("draft()")))
    browser.close()
