"""Is the Host's view of this conversation current, or stale?

Reads /composer-quill/history from the running GUI and prints the last few user
messages with their length, so a stale transcript is visible at a glance.
"""

import json
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
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
