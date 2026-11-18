"""Real-editor check for word-by-word acceptance (Tab vs Shift+Tab)."""

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
        page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("[data-composer-input]", timeout=45000)
        page.wait_for_timeout(1600)
        for label in ("继续", "Continue", "知道了"):
            button = page.locator(f"button:has-text('{label}')")
            if button.count() > 0:
                button.first.click()
                page.wait_for_timeout(500)
                break

        def draft():
            return page.evaluate("() => (document.querySelector('[data-composer-input]')||{}).textContent || ''")

        page.evaluate("""() => {
            const e = document.querySelector('[data-composer-input]');
            e.focus();
            const r = document.createRange(); r.selectNodeContents(e); r.collapse(false);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        }""")
        page.keyboard.press("Control+a")
        page.keyboard.press("Backspace")
        page.wait_for_timeout(250)
        for ch in "帮我把这个报错的现象描述清楚":
            page.keyboard.insert_text(ch)
            page.wait_for_timeout(55)

        deadline = time.time() + 25
        while time.time() < deadline:
            if page.evaluate("() => Boolean(document.querySelector('[data-composer-quill=\"dock-suggestion\"]'))"):
                break
            page.wait_for_timeout(200)

        before = draft()
        page.keyboard.press("Tab")
        page.wait_for_timeout(300)
        after_word = draft()
        word = after_word[len(before):]
        still = page.evaluate("() => Boolean(document.querySelector('[data-composer-quill=\"dock-suggestion\"]'))")
        page.keyboard.press("Shift+Tab")
        page.wait_for_timeout(300)
        after_all = draft()
        rest = after_all[len(after_word):]

        print(f"草稿长度: {len(before)} -> {len(after_word)} -> {len(after_all)}")
        print(f"Tab 取词: {word!r}；之后仍有建议: {still}")
        print(f"Shift+Tab 取余下: {rest!r}")
        ok = bool(word) and len(word) <= 4 and still and bool(rest)
        print("PASS 逐词采纳 / 全采纳" if ok else "FAIL 采纳行为不符")
        page.screenshot(path="word-accept-real.png")
        browser.close()
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
