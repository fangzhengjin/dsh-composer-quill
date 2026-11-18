"""Quality harness: type fixed drafts, print what the plugin proposes.

Run it before and after a prompt/ranking change and diff the output.
"""

import json
import sys
import time
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else ""
OUT = sys.argv[2] if len(sys.argv) > 2 else "quality.json"
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

DRAFTS = [
    "帮我把这段日志",
    "这个报错是因为什么",
    "帮我写个脚本把昨天导出的 csv 按时间排序然后",
    "请把上面的结论整理成三条要点",
    "fix the flaky test in the auth module",
]

CHIP = "() => (document.querySelector('[data-composer-quill=\"dock-suggestion\"]') || {}).textContent || ''"
GHOST = "() => { const t = document.querySelector('[data-composer-quill=\"text\"]'); return t && getComputedStyle(t).display !== 'none' ? t.textContent || '' : ''; }"


def main() -> int:
    if not URL:
        return 2
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("[data-composer-input]", timeout=45000)
        page.wait_for_timeout(1500)
        for label in ("继续", "Continue", "知道了"):
            button = page.locator(f"button:has-text('{label}')")
            if button.count() > 0:
                button.first.click()
                page.wait_for_timeout(400)
                break

        for draft in DRAFTS:
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
            # Clear any stored suggestion so each draft really asks the model.
            page.evaluate("() => window.localStorage.removeItem('dsh.composer-quill.suggestions')")

            for ch in draft:
                page.keyboard.insert_text(ch)
                page.wait_for_timeout(35)

            chip = ""
            ghost = ""
            started = time.time()
            while time.time() - started < 30:
                chip = page.evaluate(CHIP)
                ghost = page.evaluate(GHOST)
                if chip or ghost:
                    break
                page.wait_for_timeout(200)
            elapsed = round(time.time() - started, 1)
            entry = {"draft": draft, "elapsed": elapsed, "chip": chip[:120], "ghost": ghost[:120]}
            results.append(entry)
            print(f"\n[{elapsed}s] {draft}\n    chip : {chip[:100]}\n    ghost: {ghost[:100]}")

            page.keyboard.press("Control+a")
            page.keyboard.press("Backspace")
            page.wait_for_timeout(300)

        with open(OUT, "w", encoding="utf-8") as handle:
            json.dump(results, handle, ensure_ascii=False, indent=1)
        print(f"\n已写入 {OUT}")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
