#!/usr/bin/env python3
"""Servidor estático da maquete pública (porta 8103).

Serve só o que está na allowlist:
  /                         -> site/index.html
  /assets/<...>             -> arquivos em site/assets (app, estilo, fontes, three.js vendorizado)
  /data/<x>.json|<x>.bin    -> dados gerados pelo pipeline
  /data/chunks/<c>.json     -> pedaços do anel carregados perto da câmera
  /data/orto/<i>_<j>.webp   -> blocos da foto aérea (Ortofoto 2020 da Prefeitura)
  /robots.txt, /sitemap.xml, /og.jpg -> indexação e prévia de link
  /api/<fonte>              -> dados ao vivo (aovivo.py): o servidor busca na fonte, recorta o raio e guarda em cache
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
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import aovivo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")

CSP = (
    "default-src 'self'; "
    "script-src 'self' 'sha256-{inline}'; "
    "style-src 'self' 'unsafe-inline'; "  # cores das legendas e posição das pílulas vão em style=
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
    "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)
INDEXNOW = "28b9e63caa484e51e63f2863046c6c99.txt"  # chave pública do IndexNow (Bing e outros buscadores); não é segredo
NOME = re.compile(r"^[A-Za-z0-9_-]+\.(json|bin)$")
ORTO = re.compile(r"^[0-9]+_[0-9]+\.webp$")        # blocos da foto aérea (pipeline/gerar_ortofoto.py)


def hash_inline():
    """sha256 do <script> inline do index.html (tema/idioma antes do primeiro paint)."""
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    m = re.search(r"<script>(.*?)</script>", html, re.S)
    return base64.b64encode(hashlib.sha256(m.group(1).encode()).digest()).decode() if m else ""


def is_public(path):
    parts = [p for p in path.split("/") if p]
    if not parts or any(p.startswith(".") or p == ".." or "\\" in p for p in parts):
        return False
    if parts in (["index.html"], ["robots.txt"], ["sitemap.xml"], ["og.jpg"], [INDEXNOW]):
        return True
    if parts[0] == "assets":
        return len(parts) > 1 and os.path.isfile(os.path.join(ROOT, *parts))
    if parts[0] == "data":
        if len(parts) == 2:
            return bool(NOME.match(parts[1]))
        if len(parts) == 3 and parts[1] == "chunks":
            return bool(NOME.match(parts[2])) and parts[2].endswith(".json")
        if len(parts) == 3 and parts[1] == "orto":
            return bool(ORTO.match(parts[2]))
    return False


class Handler(SimpleHTTPRequestHandler):
    server_version = "bairro3d/1.0"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 20  # conexão parada (slowloris) não segura thread para sempre
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".json": "application/json",
                      ".bin": "application/octet-stream", ".js": "text/javascript", ".woff2": "font/woff2", ".webp": "image/webp"}

    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p.startswith("/api/"):
            return self.api(p[5:], corpo=True)
        return super().do_GET()

    def do_HEAD(self):
        p = self.path.split("?", 1)[0]
        if p.startswith("/api/"):
            return self.api(p[5:], corpo=False)
        return super().do_HEAD()

    def api(self, fonte, corpo):
        if fonte == "foto" or fonte.startswith("foto/"):
            return self.foto(fonte, corpo)
        r = aovivo.pegar(fonte)
        if r is None:
            return self.send_error(404)
        dados, idade, ttl = r
        if dados is None:
            return self.send_error(503, "fonte fora do ar")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(dados)))
        self.send_header("X-Idade", str(int(idade)))
        self.end_headers()
        if corpo:
            self.wfile.write(dados)

    def foto(self, fonte, corpo):
        try:
            if fonte == "foto":
                q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
                dados, tipo = aovivo.foto(float(q["lat"][0]), float(q["lon"][0])), "application/json"
            else:
                nome = fonte[5:]
                dados, tipo = (aovivo.foto_img(nome[:-4]) if nome.endswith(".jpg") else None), "image/jpeg"
        except (KeyError, ValueError):
            return self.send_error(400)
        except Exception as e:
            sys.stderr.write("foto: %s\n" % e)
            return self.send_error(503, "fonte fora do ar")
        if dados is None:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        if corpo:
            self.wfile.write(dados)

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
        if p.startswith("/api/foto"):
            self.send_header("Cache-Control", "public, max-age=86400")
        elif p.startswith("/api/"):
            self.send_header("Cache-Control", "public, max-age=%d" % aovivo.ttl(p[5:]))
        elif p.startswith("/assets/vendor/") or p.startswith("/assets/fonts/"):
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
