"""Real-instance check: local history completion fills the gap before the model."""

import json
import re
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else ""
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"
LOGS = [
    Path(r"%USERPROFILE%\.dsh\profiles\desktop\composer-quill.log"),
    Path(r"%USERPROFILE%\.dsh\composer-quill.log"),
]


def last_session_id():
    newest = None
    for path in LOGS:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines()[-200:]:
            if '"stage":"dock"' not in line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = entry.get("sessionId")
            if sid and (newest is None or entry["at"] > newest[0]):
                newest = (entry["at"], sid)
    return newest[1] if newest else None


def main() -> int:
    if not URL:
        return 2
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("[data-composer-input]", timeout=45000)
        page.wait_for_timeout(1800)
        for label in ("继续", "Continue", "知道了"):
            button = page.locator(f"button:has-text('{label}')")
            if button.count() > 0:
                button.first.click()
                page.wait_for_timeout(500)
                break

        # Walk the sidebar until a conversation with history turns up.
        items = page.locator("aside a")
        print("sidebar items:", items.count())
        session_id = None
        history = {"items": []}
        for index in range(1, min(items.count(), 8)):
            items.nth(index).click()
            page.wait_for_timeout(1400)
            candidate = last_session_id()
            if not candidate:
                continue
            data = page.evaluate(
                """async (sessionId) => {
                    const token = window.__DSH_COMPOSER_QUILL_TOKEN__ || '';
                    const response = await fetch('/composer-quill/history', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', 'x-composer-quill-token': token },
                        body: JSON.stringify({ sessionId }),
                    });
                    if (!response.ok) return { error: response.status };
                    return await response.json();
                }""",
                candidate,
            )
            found = len(data.get("items", [])) if isinstance(data, dict) else 0
            print(f"  item {index}: session={candidate[:20]}… history={found}")
            if found > 0:
                session_id = candidate
                history = data
                break

        print("session:", session_id)
        count = len(history.get("items", [])) if isinstance(history, dict) else 0
        print("history items:", count)
        if count == 0:
            print("SKIP 该会话没有历史消息")
            browser.close()
            return 0

        sample = history["items"][-1]["text"]
        prefix = sample[: max(3, min(8, len(sample) // 2))]
        print("用前缀:", prefix, "(来自:", sample[:24], ")")

        page.evaluate(
            """() => {
                const e = document.querySelector('[data-composer-input]');
                e.focus();
                const r = document.createRange(); r.selectNodeContents(e); r.collapse(false);
                const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            }"""
        )
        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        page.wait_for_timeout(300)
        started = time.time()
        for ch in prefix:
            page.keyboard.insert_text(ch)
            page.wait_for_timeout(30)

        first = None
        chip_text = ""
        while time.time() - started < 3.0:
            state = page.evaluate(
                """() => {
                    const chip = document.querySelector('[data-composer-quill="dock-suggestion"]');
                    const ghost = document.querySelector('[data-composer-quill="text"]');
                    return {
                        chip: chip ? chip.textContent || '' : '',
                        ghost: ghost && getComputedStyle(ghost).display !== 'none' ? ghost.textContent || '' : '',
                    };
                }"""
            )
            if state["chip"] or state["ghost"]:
                first = time.time() - started
                chip_text = state["chip"] or state["ghost"]
                break
            page.wait_for_timeout(20)

        elapsed = round(first, 2) if first is not None else None
        print(f"首个建议耗时: {elapsed}s；内容: {chip_text[:40]!r}")
        ok = first is not None and first < 0.6
        print("PASS 历史补全即时出现" if ok else "FAIL 未在 0.6s 内出现")
        page.screenshot(path="history-real.png")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
