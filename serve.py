#!/usr/bin/env python3
"""Servidor estático da maquete pública (porta 8103).

Serve só o que está na allowlist:
  /                         -> site/index.html
  /assets/<...>             -> arquivos em site/assets (app, estilo, fontes, three.js vendorizado)
  /data/<x>.json|<x>.bin    -> dados gerados pelo pipeline
  /data/chunks/<c>.json     -> pedaços do anel carregados perto da câmera
Qualquer outra coisa (diretórios, dotfiles, .py, caminhos com ..) é 404.

Bind padrão em 127.0.0.1: só a própria máquina acessa até a revisão. Para expor (túnel, proxy),
passe o endereço explicitamente: python3 serve.py 8103 0.0.0.0

Uso: python3 serve.py [porta] [endereço]
"""
import base64
import hashlib
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")

CSP = (
    "default-src 'self'; "
    "script-src 'self' 'sha256-{inline}'; "
    "style-src 'self' 'unsafe-inline'; "  # cores das legendas e posição das pílulas vão em style=
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
NOME = re.compile(r"^[A-Za-z0-9_-]+\.(json|bin)$")


def hash_inline():
    """sha256 do <script> inline do index.html (tema/idioma antes do primeiro paint)."""
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    m = re.search(r"<script>(.*?)</script>", html, re.S)
    return base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode() if m else ""


def is_public(path):
    parts = [p for p in path.split("/") if p]
    if not parts or any(p.startswith(".") or p == ".." or "\\" in p for p in parts):
        return False
    if parts == ["index.html"]:
        return True
    if parts[0] == "assets":
        return len(parts) > 1 and os.path.isfile(os.path.join(ROOT, *parts))
    if parts[0] == "data":
        if len(parts) == 2:
            return bool(NOME.match(parts[1]))
        if len(parts) == 3 and parts[1] == "chunks":
            return bool(NOME.match(parts[2])) and parts[2].endswith(".json")
    return False


class Handler(SimpleHTTPRequestHandler):
    server_version = "bairro3d/1.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".json": "application/json",
                      ".bin": "application/octet-stream", ".js": "text/javascript", ".woff2": "font/woff2"}

    def do_POST(self):
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_POST

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean in ("/", "/index.html"):
            clean = "/index.html"
        if not is_public(clean):
            return os.path.join(ROOT, ".blocked")  # nunca existe -> 404
        return super().translate_path(clean)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def end_headers(self):
        p = self.path.split("?", 1)[0]
        if p.startswith("/assets/vendor/") or p.startswith("/assets/fonts/"):
            self.send_header("Cache-Control", "public, max-age=604800, immutable")
        elif p.startswith("/assets/") or p.startswith("/data/"):
            self.send_header("Cache-Control", "public, max-age=3600")
        else:
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.send_header("Content-Security-Policy", CSP.format(inline=self.server.inline_hash))
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8103
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    os.chdir(ROOT)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.inline_hash = hash_inline()
    sys.stderr.write("bairro3d em %s:%d (%s)\n" % (host, port, ROOT))
    srv.serve_forever()


if __name__ == "__main__":
    main()
