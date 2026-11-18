"""Open DSH settings and capture this plugin's row as it really renders."""

import json
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else ""
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

CANDIDATES = """
() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')];
  return nodes.map((n, i) => ({
    i,
    tag: n.tagName,
    text: (n.textContent || '').trim().slice(0, 24),
    aria: n.getAttribute('aria-label') || '',
    title: n.getAttribute('title') || '',
    testid: n.getAttribute('data-testid') || '',
  })).filter((n) => n.text || n.aria || n.title || n.testid).slice(0, 60);
}
"""


def main() -> int:
    if not URL:
        return 2
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector("[data-composer-input]", timeout=45000)
        page.wait_for_timeout(1800)
        for label in ("继续", "Continue", "知道了"):
            button = page.locator(f"button:has-text('{label}')")
            if button.count() > 0:
                button.first.click()
                page.wait_for_timeout(500)
                break

        print("=== 可点元素（前 40） ===")
        for item in page.evaluate(CANDIDATES)[:40]:
            print(" ", json.dumps(item, ensure_ascii=False))

        # Settings lives behind the "更多" (More) entry in this shell.
        opened = False
        more = page.locator("[aria-label='更多'], button:has-text('更多')")
        if more.count() > 0:
            more.first.click()
            page.wait_for_timeout(900)
            print("=== 更多菜单 ===")
            for item in page.evaluate(CANDIDATES):
                if item["aria"] or item["text"]:
                    print(" ", json.dumps(item, ensure_ascii=False))
            for selector in (
                "[role='menuitem']:has-text('设置')",
                "button:has-text('设置')",
                "text=设置",
            ):
                locator = page.locator(selector)
                if locator.count() > 0:
                    locator.first.click()
                    page.wait_for_timeout(1400)
                    opened = True
                    print("opened via", selector)
                    break

        if not opened:
            # Keyboard shortcut used by many shells.
            page.keyboard.press("Control+Comma")
            page.wait_for_timeout(1200)

        page.wait_for_timeout(800)
        print("=== 设置界面标题 ===")
        print(page.evaluate("() => document.body.innerText.slice(0, 400)"))

        row = page.locator("[data-composer-quill='settings-row']")
        print("plugin row count:", row.count())
        if row.count() > 0:
            box = row.first.bounding_box()
            text = row.first.inner_text()
            print("row text:", text.replace("\n", " | ")[:200])
            print("row box:", box)
            row.first.screenshot(path="settings-row.png")
            page.screenshot(path="settings-full.png")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
