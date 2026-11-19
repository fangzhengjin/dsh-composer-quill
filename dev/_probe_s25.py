"""Replicate S25 and print what the store and the dock actually hold."""

import json
import os
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
HARNESS = HERE / "harness" / "index.html"


def chrome_path():
    override = os.environ.get("DSH_CHROME")
    if override:
        return override
    root = Path.home() / "AppData" / "Local" / "ms-playwright"
    for candidate in sorted(root.glob("chromium-*/chrome-win/chrome.exe"), reverse=True):
        return str(candidate)
    return None


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=chrome_path())
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
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

        for i in range(12):
            page.wait_for_timeout(600)
            store = h("store()") or {}
            dom = page.evaluate(
                """() => {
                    const dock = document.querySelector('[data-composer-quill="dock"]');
                    const chip = document.querySelector('[data-composer-quill="dock-suggestion"]');
                    const ghost = document.querySelector('[data-composer-quill="text"]');
                    return {
                        draft: document.querySelector('[data-composer-input]')?.textContent ?? '',
                        dock: dock ? dock.textContent : '',
                        chip: chip ? chip.textContent : '',
                        ghost: ghost ? ghost.textContent : '',
                        ghostDisplay: ghost ? getComputedStyle(ghost).display : '',
                    };
                }"""
            )
            print(
                f"{i}: phase={store.get('phase')} items={len(store.get('items') or [])} "
                f"forDraft={len(store.get('forDraft') or '')} draft={len(dom['draft'])} "
                f"chip={dom['chip'][:26]!r} ghost={dom['ghost'][:16]!r}/{dom['ghostDisplay']}"
            )
            if dom["chip"] or dom["ghost"]:
                break

        print("aborts:", h("aborts()"), "compose calls:", len([c for c in h("calls") if c["mode"] == "compose"]))
        print("page errors:", errors[:2])
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
