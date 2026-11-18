"""Real-editor check: one character is enough, and Tab takes the whole tail."""

import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else ""
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"


def main() -> int:
    if not URL:
        return 2
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("[data-composer-input]", timeout=45000)
        page.wait_for_timeout(1600)
        for label in ("继续", "Continue", "知道了"):
            button = page.locator(f"button:has-text('{label}')")
            if button.count() > 0:
                button.first.click()
                page.wait_for_timeout(400)
                break

        def snap():
            return page.evaluate(
                """() => {
                    const row = document.querySelector('[data-composer-quill="dock"]');
                    const proposal = document.querySelector('[data-composer-quill="dock-suggestion"]');
                    const hint = document.querySelector('[data-composer-quill="dock-hint"]');
                    const ghost = document.querySelector('[data-composer-quill="text"]');
                    return {
                        present: Boolean(row),
                        proposal: proposal ? proposal.textContent || '' : '',
                        hint: hint ? hint.textContent || '' : '',
                        ghost: ghost && getComputedStyle(ghost).display !== 'none' ? ghost.textContent || '' : '',
                        draft: (document.querySelector('[data-composer-input]') || {}).textContent || '',
                    };
                }"""
            )

        page.evaluate(
            """() => {
                const editor = document.querySelector('[data-composer-input]');
                editor.focus();
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }"""
        )
        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        page.wait_for_timeout(300)

        # Exactly one character.
        page.keyboard.insert_text("帮")
        started = time.time()
        found = None
        while time.time() - started < 20:
            current = snap()
            if current["proposal"] or current["ghost"]:
                found = current
                break
            page.wait_for_timeout(200)
        elapsed = round(time.time() - started, 2)
        print(f"单字草稿 -> {elapsed}s 建议: {(found or {}).get('proposal', '')[:34]!r}")

        before = snap()["draft"]
        page.keyboard.press("Tab")
        page.wait_for_timeout(400)
        after = snap()
        inserted = after["draft"][len(before):]
        print(f"Tab 插入整段: {inserted!r}  草稿长度 {len(before)} -> {len(after['draft'])}")
        ok = found is not None and bool(inserted) and len(inserted) > 4
        print("PASS 单字即给建议且 Tab 一次取完" if ok else "FAIL 未达预期")
        page.screenshot(path="single-char-accept.png")
        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
