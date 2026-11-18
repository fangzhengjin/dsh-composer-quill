"""Is the Host's view of this conversation current, or stale?

Reads /composer-quill/history from the running GUI and prints the last few user
messages with their length, so a stale transcript is visible at a glance.
"""

import os
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
def _chrome_path():
    """Chromium for Playwright, located at runtime instead of hard-coded."""
    override = os.environ.get("DSH_CHROME")
    if override:
        return override
    roots = [
        Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")) if os.environ.get("PLAYWRIGHT_BROWSERS_PATH") else None,
        Path.home() / "AppData" / "Local" / "ms-playwright",
        Path.home() / ".cache" / "ms-playwright",
    ]
    patterns = ["chromium-*/chrome-win/chrome.exe", "chromium-*/chrome-linux/chrome", "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
    for root in roots:
        if root is None or not root.exists():
            continue
        for pattern in patterns:
            for candidate in sorted(root.glob(pattern), reverse=True):
                return str(candidate)
    return None


CHROME = _chrome_path()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME or None)
    page = browser.new_page()
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(2500)
    info = page.evaluate(
        """async () => {
            const token = window.__DSH_COMPOSER_QUILL_TOKEN__ || '';
            const globals = Object.keys(window).filter((key) => key.startsWith('__DSH'));
            // The Session id is not exposed globally: read it from the composer slot if possible.
            const q = (selector) => document.querySelector(selector);
            return { token: token.slice(0, 6) + '…', hasToken: Boolean(token), globals: globals.slice(0, 6) };
        }"""
    )
    print("注入信息：", info)

    sessions = page.evaluate(
        """async () => {
            const token = window.__DSH_COMPOSER_QUILL_TOKEN__ || '';
            const probe = async (path, body) => {
                const response = await fetch(path, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-composer-quill-token': token },
                    body: JSON.stringify(body),
                });
                return { status: response.status, body: await response.json().catch(() => null) };
            };
            return probe('/composer-quill/history', { sessionId: new URLSearchParams(location.search).get('session') || '' });
        }"""
    )
    print("history 探测：", json.dumps(sessions, ensure_ascii=False)[:300])
    page.screenshot(path="host-history.png")
    browser.close()
