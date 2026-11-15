#!/usr/bin/env python3
"""CGS dashboard: a local page that tracks a Capital Growth System portfolio.

    python3 server.py [--port 8787]

Serves static/ on 127.0.0.1 only. All data work happens in the browser
(static/data.js): each person's browser fetches their own wallets' positions
from the protocols' APIs and keeps wallets, manual rows, settings and history
in its localStorage. Besides the files, the server answers two requests:

/keys.json tells the page whether Zerion is set up and gives the WalletConnect
project ID, both from .env (ZERION_API_KEY, WALLETCONNECT_PROJECT_ID); unset turns
Zerion / WalletConnect off. /zerion/v1/wallets/… is passed on to api.zerion.io with
the key added, so the key never reaches the browser.

/api/seed hands the settings an earlier version kept in data/ (config.json,
manual.json, history.jsonl) to a browser that has none yet, so upgrading
loses nothing. Without data/ it returns 404 and the
page starts empty.
"""
import argparse
import base64
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
STATIC = ROOT / "static"


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def env(name):
    value = os.environ.get(name, "")
    path = ROOT / ".env"
    if not value and path.exists():
        for line in path.read_text().splitlines():
            if line.startswith(f"{name}="):
                value = line.split("=", 1)[1].strip().strip("'\"")
    return value


def seed():
    config, manual = read_json(DATA / "config.json"), read_json(DATA / "manual.json")
    if config is None and manual is None:
        return None
    history = []
    if (DATA / "history.jsonl").exists():
        history = [json.loads(line) for line in (DATA / "history.jsonl").read_text().splitlines() if line.strip()]
    return {"config": config, "manual": manual, "history": history}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/keys.json":
            return self.send(200, {"zerion": bool(env("ZERION_API_KEY")), "walletconnect": env("WALLETCONNECT_PROJECT_ID")})
        if path.startswith("/zerion/v1/wallets/") and env("ZERION_API_KEY"):
            return self.zerion()
        if path == "/api/seed":
            s = seed()
            return self.send(200, s) if s else self.send(404, {"error": "no saved data"})
        rel = "index.html" if path == "/" else path.lstrip("/")
        file = (STATIC / rel).resolve()
        if STATIC not in file.parents or not file.is_file():
            return self.send(404, {"error": "not found"})
        ctype = {".html": "text/html", ".css": "text/css", ".js": "text/javascript",
                 ".svg": "image/svg+xml"}.get(file.suffix, "application/octet-stream")
        self.send(200, file.read_bytes(), ctype + "; charset=utf-8")

    def zerion(self):
        key = base64.b64encode(f"{env('ZERION_API_KEY')}:".encode()).decode()
        req = urllib.request.Request("https://api.zerion.io/" + self.path.removeprefix("/zerion/"),
                                     headers={"Authorization": f"Basic {key}", "Accept": "application/json", "User-Agent": "cgs-dashboard"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return self.send(r.status, r.read())
        except urllib.error.HTTPError as e:
            return self.send(e.code, e.read())
        except OSError as e:
            return self.send(502, {"error": str(e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"CGS dashboard → http://localhost:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
