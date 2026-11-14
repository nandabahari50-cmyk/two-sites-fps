"""Project the viewmodel's hand groups into screen space and report where they land.

Guessing at the weapon's transform by eye has failed twice, so this measures instead: it loads the
page, reaches into the live scene through the page's own THREE instance, walks the viewmodel for the
two hand groups, and projects each one's world position through the view camera to NDC. Anything
outside ±1 in x or y is off-screen, and the numbers say exactly how far off — which turns "hands do
not show" into a transform to correct rather than another guess.

It also reports the camera's frustum height at the weapon's depth, so a fix can be computed rather
than eyeballed.
"""

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

PORT = 8933
ROOT = Path("/root/.hermes/shared/makefun/fps")

PROBE = r"""
() => {
  const out = { frames: [], camera: null, gun: null, meshes: [] };
  const canvas = document.querySelector('#game canvas');
  // three does not expose the scene globally; walk every object we can reach from the renderer's
  // last render by hooking the prototype before the game boots is not possible here, so instead
  // read the values the game itself keeps on window for the shot harness.
  if (!window.__probe) return { error: 'no probe bridge' };
  const p = window.__probe();
  return p;
}
"""


async def main() -> int:
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=str(ROOT / "game"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                args=["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle"]
            )
            page = await browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            await page.goto(f"http://127.0.0.1:{PORT}/index.html?shot=play&seed=1", wait_until="load")
            try:
                await page.wait_for_function("window.__shotReady === true", timeout=30000)
            except Exception as exc:
                print("shot never became ready:", exc)
            result = await page.evaluate(PROBE)
            print(json.dumps(result, indent=2)[:4000])
            if errors:
                print("PAGE ERRORS:")
                for e in errors[:10]:
                    print("  ", e)
            await browser.close()
    finally:
        server.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
