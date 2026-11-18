"""Real-editor check: the suggestion row is always present and never jumps."""

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

        def dock():
            return page.evaluate(
                """() => {
                    const row = document.querySelector('[data-composer-quill="dock"]');
                    const proposal = document.querySelector('[data-composer-quill="dock-suggestion"]');
                    const pending = document.querySelector('[data-composer-quill="dock-pending"]');
                    const hint = document.querySelector('[data-composer-quill="dock-hint"]');
                    const box = row ? row.getBoundingClientRect() : null;
                    return {
                        present: Boolean(row),
                        height: box ? Math.round(box.height) : null,
                        proposal: proposal ? proposal.textContent || '' : '',
                        pending: Boolean(pending),
                        hint: hint ? hint.textContent || '' : '',
                    };
                }"""
            )

        page.wait_for_timeout(800)
        idle = dock()
        print("空闲:", idle)
        if dock()["present"]:
            page.locator("[data-composer-quill='dock']").screenshot(path="dock-idle.png")

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
        for ch in "帮我把这段日志":
            page.keyboard.insert_text(ch)
            page.wait_for_timeout(55)

        deadline = time.time() + 25
        while time.time() < deadline:
            if dock()["proposal"]:
                break
            page.wait_for_timeout(200)
        busy = dock()
        print("有建议:", busy)
        page.locator("[data-composer-quill='dock']").screenshot(path="dock-proposal.png")

        heights = {idle["height"], busy["height"]}
        ok = idle["present"] and busy["present"] and len(heights) == 1 and bool(busy["proposal"])
        print("PASS 建议行常驻且高度一致" if ok else "FAIL 建议行不常驻或高度跳变")
        page.screenshot(path="dock-real.png")

        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
