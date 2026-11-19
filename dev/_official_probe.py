"""Find how the official client renders the composer and any inline ghost text."""

import re
import sys
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright

URL = sys.argv[1]
OUT = Path(__file__).resolve().parent / "_official"
OUT.mkdir(exist_ok=True)
CHROME = r"C:\Users\dqdyfrw\AppData\Local\ms-playwright\chromium-1148\chrome-win\chrome.exe"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    assets = []
    page.on("response", lambda r: assets.append((r.url, r.status)))
    page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(4000)

    print("客户端资源（前 20 条）:")
    for url, status in assets[:20]:
        if any(ext in url for ext in (".js", ".css")):
            print(f"  {status} {url[:110]}")

    # Grab the composer markup: that is what the ghost has to coexist with.
    html = page.evaluate(
        """() => {
            const editor = document.querySelector('[data-composer-input]');
            if (!editor) return '(没有找到输入框)';
            let node = editor;
            const chain = [];
            for (let depth = 0; node && depth < 6; depth += 1) {
                const style = getComputedStyle(node);
                chain.push({
                    tag: node.tagName.toLowerCase(),
                    cls: (node.className || '').toString().slice(0, 60),
                    overflow: `${style.overflowX}/${style.overflowY}`,
                    position: style.position,
                    radius: style.borderRadius,
                    zIndex: style.zIndex,
                    rect: (() => { const r = node.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` })(),
                });
                node = node.parentElement;
            }
            return chain;
        }"""
    )
    print("\n输入框向上的祖先链（实时界面）:")
    for item in html:
        print(f"  {item['tag']:<6} pos={item['position']:<8} overflow={item['overflow']:<16} radius={item['radius']:<8} z={item['zIndex']:<6} rect={item['rect']:<24} cls={item['cls']}")

    browser.close()
