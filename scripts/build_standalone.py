#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docs/ 를 파일 하나로 묶어 오프라인에서도 열리는 HTML을 만든다.

사용: python3 scripts/build_standalone.py
결과: standalone/global-stock-planner.html  (데이터·차트 라이브러리·스타일 내장)
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
OUT_DIR = os.path.join(ROOT, "standalone")


def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def main():
    html = read(os.path.join(DOCS, "index.html"))
    css = read(os.path.join(DOCS, "style.css"))
    app = read(os.path.join(DOCS, "app.js"))
    lw = read(os.path.join(DOCS, "vendor", "lwcharts.js"))
    data = read(os.path.join(DOCS, "data", "stocks.json"))

    hist = {}
    hist_dir = os.path.join(DOCS, "data", "hist")
    for fn in sorted(os.listdir(hist_dir)):
        if fn.endswith(".json"):
            hist[fn[:-5]] = json.loads(read(os.path.join(hist_dir, fn)))

    html = html.replace('<link rel="stylesheet" href="style.css">', "<style>\n" + css + "\n</style>")
    html = html.replace('<link rel="manifest" href="manifest.json">\n', "")
    html = html.replace('<link rel="icon" href="icon.svg" type="image/svg+xml">\n', "")
    html = html.replace('<link rel="apple-touch-icon" href="icon.svg">\n', "")
    html = html.replace('<script src="vendor/lwcharts.js"></script>',
                        "<script>\n" + lw + "\n</script>")
    snap = ("<script>window.__SNAP__=" + data + ";\nwindow.__HIST__=" +
            json.dumps(hist, ensure_ascii=False, separators=(",", ":")) + ";</script>")
    html = html.replace('<script src="app.js"></script>', snap + "\n<script>\n" + app + "\n</script>")

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "global-stock-planner.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"생성: {out} ({os.path.getsize(out)/1024/1024:.2f}MB)")


if __name__ == "__main__":
    main()
