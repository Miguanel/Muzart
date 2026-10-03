"""
Muzart Web — serwer Flask.

Serwuje aplikację PWA (Progressive Web App) zbudowaną na podstawie
aplikacji Muzart na Androida. Cała logika audio działa w przeglądarce
(Web Audio API), a dane użytkownika są przechowywane lokalnie na
urządzeniu (IndexedDB), więc serwer jest lekki i bezstanowy.

Uruchomienie lokalne:
    pip install -r requirements.txt
    python app.py            -> http://localhost:5000

Produkcja (Render):
    gunicorn app:app
"""

import hashlib
import json
import os
from pathlib import Path

from flask import Flask, Response, jsonify, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


def _compute_build_version() -> str:
    """Hash wszystkich plików statycznych — zmienia się przy każdym wdrożeniu,
    dzięki czemu Service Worker automatycznie pobiera nową wersję aplikacji."""
    digest = hashlib.sha256()
    for path in sorted(STATIC_DIR.rglob("*")):
        if path.is_file() and path.name != "sw.js":
            digest.update(str(path.relative_to(STATIC_DIR)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


BUILD_VERSION = os.environ.get("MUZART_VERSION") or _compute_build_version()


def _list_precache_files() -> list:
    files = ["/", "/manifest.webmanifest"]
    for path in sorted(STATIC_DIR.rglob("*")):
        if path.is_file() and path.name not in ("sw.js", "index.html", "manifest.webmanifest"):
            files.append("/static/" + path.relative_to(STATIC_DIR).as_posix())
    return files


@app.after_request
def add_security_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    # Mikrofon jest potrzebny do nagrywania — tylko z tej samej domeny.
    response.headers.setdefault("Permissions-Policy", "microphone=(self)")
    return response


@app.route("/")
def index():
    response = send_from_directory(STATIC_DIR, "index.html")
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/manifest.webmanifest")
def manifest():
    response = send_from_directory(STATIC_DIR, "manifest.webmanifest",
                                   mimetype="application/manifest+json")
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/sw.js")
def service_worker():
    source = (STATIC_DIR / "sw.js").read_text(encoding="utf-8")
    source = source.replace("__BUILD_VERSION__", BUILD_VERSION)
    source = source.replace("__PRECACHE_FILES__", json.dumps(_list_precache_files()))
    response = Response(source, mimetype="application/javascript")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(STATIC_DIR / "icons", "favicon.ico")


@app.route("/apple-touch-icon.png")
@app.route("/apple-touch-icon-precomposed.png")
def apple_touch_icon():
    return send_from_directory(STATIC_DIR / "icons", "apple-touch-icon.png")


@app.route("/healthz")
def healthz():
    return jsonify(status="ok", version=BUILD_VERSION)


@app.route("/api/version")
def version():
    return jsonify(version=BUILD_VERSION)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
