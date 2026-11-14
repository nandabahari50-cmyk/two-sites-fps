"""Render the game's screenshots with Playwright and report any runtime error.

The screenshots are part of the submission, so they must be the real game rendering: this script
serves game/, opens each shot URL in headless Chromium with WebGL, waits for window.__shotReady,
and writes the PNG. Any console error or page error is printed and fails the run, because a
screenshot of a half-broken frame is worse than no screenshot.
"""

import asyncio
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

PORT = 8921
ROOT = Path("/root/.hermes/shared/makefun/fps")
OUT = ROOT / "screenshots"

SHOTS = [
    ("1-site.jpg", "?shot=play&seed=1", 1280, 800),
    ("2-bomb.jpg", "?shot=end&seed=1", 1280, 800),
    ("3-buy.jpg", "?shot=buy&seed=1", 1280, 800),
    ("4-freeze.jpg", "?shot=freeze&seed=1", 1280, 800),
]


async def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=str(ROOT / "game"),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    failures = 0
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                args=["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
            )
            for name, query, w, h in SHOTS:
                page = await browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
                errors = []
                page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error",) else None)
                page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
                await page.goto(f"http://127.0.0.1:{PORT}/index.html{query}", wait_until="load")
                try:
                    await page.wait_for_function("window.__shotReady === true", timeout=25000)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"__shotReady never set: {exc}")
                await page.wait_for_timeout(250)
                await page.screenshot(path=str(OUT / name), type="jpeg", quality=88)
                size = (OUT / name).stat().st_size
                verdict = "ok" if not errors else "ERR"
                print(f"{name}: {size:,} bytes [{verdict}]")
                for e in errors[:6]:
                    print(f"   {e}")
                if errors:
                    failures += 1
                await page.close()
            await browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
    print("FAILURES:", failures)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
