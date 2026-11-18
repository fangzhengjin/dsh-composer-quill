"""Switching Sessions must reuse the stored next-message, not re-sample it."""

import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

STATE = """() => {
  const chip = document.querySelector('[data-composer-quill="dock-suggestion"]');
  const ghost = document.querySelector('[data-composer-quill="text"]');
  const pending = document.querySelector('[data-composer-quill="dock-pending"]');
  const hint = document.querySelector('[data-composer-quill="dock-hint"]');
  return {
    chip: chip ? (chip.textContent || '') : '',
    ghost: ghost && getComputedStyle(ghost).display !== 'none' ? (ghost.textContent || '') : '',
    pending: Boolean(pending),
    hint: hint ? (hint.textContent || '') : '',
  };
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("[data-composer-input]", timeout=45000)
    page.wait_for_timeout(1500)
    for label in ("继续", "Continue", "知道了"):
        button = page.locator(f"button:has-text('{label}')")
        if button.count() > 0:
            button.first.click()
            page.wait_for_timeout(400)
            break

    def new_chat():
        for label in ("新会话", "New chat", "新建会话"):
            button = page.locator(f"button:has-text('{label}')")
            if button.count() > 0:
                button.first.click()
                return True
        return False

    first = page.evaluate(STATE)
    print("初始会话：", {k: (v[:24] if isinstance(v, str) else v) for k, v in first.items()})

    # Create a second Session and come back to the first one via the sidebar.
    created = new_chat()
    page.wait_for_timeout(2500)
    second = page.evaluate(STATE)
    print(f"新会话创建={created}：", {k: (v[:24] if isinstance(v, str) else v) for k, v in second.items()})

    # The sidebar lists the previous conversation; click the first entry.
    entries = page.locator("[data-session-id], a[href*='/session/'], button:has-text('新会话')")
    print("侧栏条目数：", entries.count())
    sw = page.evaluate(
        """() => {
            const items = Array.from(document.querySelectorAll('[data-session-id]'));
            return items.slice(0, 4).map((node) => node.getAttribute('data-session-id'));
        }"""
    )
    print("侧栏会话 id：", sw)

    page.screenshot(path="session-switch.png")
    browser.close()
