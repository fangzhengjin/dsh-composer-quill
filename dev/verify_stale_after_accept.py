"""After Tab, the dock must not keep showing the text that is now in the editor."""

import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
CHROME = r"%USERPROFILE%\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

STATE = """() => {
  const row = document.querySelector('[data-composer-quill="dock"]');
  const chip = document.querySelector('[data-composer-quill="dock-suggestion"]');
  const editor = document.querySelector('[data-composer-input]');
  return {
    draft: editor ? (editor.textContent || '') : '',
    chip: chip ? (chip.textContent || '') : '',
    present: Boolean(row),
  };
}"""


def focus(page):
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

    # A draft that then gets cleared: that transition asks for the next message.
    focus(page)
    page.keyboard.insert_text("帮我看下这个报错")
    page.wait_for_timeout(1500)
    page.keyboard.press("Control+a")
    page.keyboard.press("Backspace")

    chip = ""
    for _ in range(40):
        page.wait_for_timeout(250)
        chip = page.evaluate(STATE)["chip"]
        if "按 Tab 采纳" in chip:
            break
    print(f"清空后 chip: {chip[:40]!r}")

    before = page.evaluate(STATE)
    page.keyboard.press("Tab")
    page.wait_for_timeout(900)
    after = page.evaluate(STATE)
    print(f"采纳后 草案: {after['draft'][:40]!r}")
    print(f"采纳后 chip: {after['chip'][:40]!r}")

    draft_norm = after["draft"].replace(" ", "").strip()
    chip_norm = after["chip"].replace(" ", "")
    duplicated = bool(draft_norm) and draft_norm in chip_norm
    ok = bool(draft_norm) and not duplicated
    print(
        "PASS 采纳后不再重复显示同一句" if ok
        else f"FAIL duplicated={duplicated} draft={draft_norm[:20]!r} chip={chip_norm[:20]!r}"
    )
    page.screenshot(path="stale-after-accept.png")
    browser.close()
    sys.exit(0 if ok else 1)
