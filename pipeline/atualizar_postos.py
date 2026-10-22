#!/usr/bin/env python3
"""Preço dos combustíveis nos postos em volta do centro do config.json -> postos.json (lido pela maquete).

Fontes:
  - ANP, "últimas 4 semanas" (dados abertos, coleta semanal por posto, com CNPJ e endereço). Só uma amostra
    dos postos da cidade é pesquisada a cada semana, então nem todo posto do raio tem preço.
  - OpenStreetMap (Overpass): todos os postos do raio, com posição exata. Os da ANP são geocodificados pelo
    endereço (Nominatim, 1 pedido/s, com cache por CNPJ) e grudados no posto do OSM mais próximo.

Uso: python3 atualizar_postos.py <saida.json> [pasta_cache]
A ANP atualiza uma vez por semana; o cache por CNPJ evita refazer a geocodificação.
"""
import csv
import io
import json
import math
import os
import re
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import CFG, LAT0, LON0, ANEL as RAIO, KX, KY  # noqa: E402
ANP_URL = "https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/shpc/qus/ultimas-4-semanas-gasolina-etanol.csv"
OVERPASS = "https://overpass-api.de/api/interpreter"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
UA = "bairro3d-publico/1.0 (maquete 3D com dados abertos; poucas consultas por semana)"
GRUDA_M = 150                             # posto da ANP a até isso de um posto do OSM vira o mesmo posto
# a ANP registra a distribuidora; no posto aparece a marca
BANDEIRAS = {"Raizen": "Shell", "Vibra": "Petrobras", "Branca": "Bandeira branca", "Ale": "ALE", "Ipiranga": "Ipiranga"}
PRODUTOS = {"GASOLINA": "g", "GASOLINA ADITIVADA": "ga", "ETANOL": "e"}


def baixar(url, dados=None, timeout=90):
    req = urllib.request.Request(url, data=dados, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def xy(lat, lon):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def sem_acento(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().upper()


def titulo(s):
    s = re.sub(r"\s+", " ", s).strip().title()
    for a, b in ((" Ltda", ""), (" Ltda.", ""), (" Eireli", ""), (" Me", ""), (" De ", " de "), (" Da ", " da "),
                 (" Do ", " do "), (" Dos ", " dos "), (" Das ", " das "), (" E ", " e ")):
        s = s.replace(a, b)
    return s.strip(" .-")


def anp():
    """{cnpj: {nome, bandeira, rua, num, bairro, cep, precos{g,ga,e}, data}} só da cidade de São Paulo, coleta mais recente."""
    bruto = baixar(ANP_URL)
    try:
        txt = bruto.decode("utf-8-sig")   # hoje vem em UTF-8 com BOM; arquivos antigos da ANP eram latin-1
    except UnicodeDecodeError:
        txt = bruto.decode("latin-1")
    postos = {}
    for r in csv.DictReader(io.StringIO(txt), delimiter=";"):
        r = {k.strip().lstrip("﻿"): (v or "").strip() for k, v in r.items() if k}
        if r.get("Estado - Sigla") != "SP" or sem_acento(r.get("Municipio", "")) != "SAO PAULO":
            continue
        prod = PRODUTOS.get(r.get("Produto", "").upper())
        if not prod:
            continue
        cnpj = re.sub(r"\D", "", r["CNPJ da Revenda"])
        data = datetime.strptime(r["Data da Coleta"], "%d/%m/%Y").date().isoformat()
        p = postos.setdefault(cnpj, {"cnpj": cnpj, "nome": titulo(r["Revenda"]), "bandeira": BANDEIRAS.get(r.get("Bandeira", "").title(), r.get("Bandeira", "").title()),
                                     "rua": titulo(r["Nome da Rua"]), "num": r["Numero Rua"], "bairro": titulo(r["Bairro"]),
                                     "cep": r["Cep"], "precos": {}, "data": data})
        if data > p["data"]:   # coleta mais nova manda
            p["data"], p["precos"] = data, {}
        if data == p["data"]:
            p["precos"][prod] = float(r["Valor de Venda"].replace(",", "."))
    return postos


def osm():
    q = f'[out:json][timeout:60];nwr["amenity"="fuel"](around:{RAIO},{LAT0},{LON0});out center tags;'
    d = json.loads(baixar(OVERPASS, ("data=" + urllib.parse.quote(q)).encode()))
    out = []
    for e in d["elements"]:
        lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
        t = e.get("tags", {})
        out.append({"osm": f'{e["type"][0]}{e["id"]}', "lat": lat, "lon": lon, "nome": t.get("name", ""),
                    "bandeira": t.get("brand", "") or t.get("operator", ""),
                    "end": " ".join(x for x in (t.get("addr:street", ""), t.get("addr:housenumber", "")) if x)})
    return out


def geocodificar(p, cache):
    chave = f'{p["cnpj"]}|{p["rua"]}|{p["num"]}'
    if chave in cache:
        return cache[chave]
    pontos = None
    for q in ({"street": f'{p["num"]} {p["rua"]}', "city": "São Paulo", "state": "SP", "country": "Brasil"},
              {"postalcode": p["cep"], "city": "São Paulo", "country": "Brasil"}):
        time.sleep(1.1)
        try:
            r = json.loads(baixar(NOMINATIM + "?" + urllib.parse.urlencode({**q, "format": "json", "limit": 1}), timeout=30))
        except Exception as e:  # noqa: BLE001 - rede instável: tenta na próxima rodada
            print("nominatim:", e, file=sys.stderr)
            return None
        if r:
            pontos = [float(r[0]["lat"]), float(r[0]["lon"]), "rua" if "street" in q else "cep"]
            break
    cache[chave] = pontos
    return pontos


def main():
    saida = sys.argv[1]
    pasta = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(saida))
    cache_path = os.path.join(pasta, "postos-geocache.json")
    try:
        cache = json.load(open(cache_path))
    except (OSError, ValueError):
        cache = {}

    da_anp, do_osm = anp(), osm()
    usados, postos = set(), []
    for p in da_anp.values():
        if not any(p["cep"].startswith(c) for c in CFG.get("cep_prefixos", [""])):   # filtro barato antes de geocodificar
            continue
        g = geocodificar(p, cache)
        if not g:
            continue
        x, y = xy(g[0], g[1])
        if math.hypot(x, y) > RAIO + 200:
            continue
        # gruda no posto do OSM mais próximo (posição melhor que a do endereço)
        perto = min(do_osm, key=lambda o: math.hypot(*(a - b for a, b in zip(xy(o["lat"], o["lon"]), (x, y)))), default=None)
        lat, lon, osm_id = g[0], g[1], None
        if perto:
            d = math.hypot(*(a - b for a, b in zip(xy(perto["lat"], perto["lon"]), (x, y))))
            if d <= GRUDA_M and perto["osm"] not in usados:
                lat, lon, osm_id = perto["lat"], perto["lon"], perto["osm"]
                usados.add(osm_id)
        x, y = xy(lat, lon)
        if math.hypot(x, y) > RAIO:
            continue
        postos.append({"n": p["nome"], "b": p["bandeira"], "end": f'{p["rua"]}, {p["num"]} · {p["bairro"]}',
                       "lat": round(lat, 6), "lon": round(lon, 6), "m": round(math.hypot(x, y)), "data": p["data"],
                       **{k: v for k, v in p["precos"].items()}, "geo": "osm" if osm_id else g[2]})
    # o OSM às vezes tem o mesmo posto duas vezes (ponto e contorno): fica um só por 40 m
    unicos = []
    for o in do_osm:
        if o["osm"] in usados:
            continue
        ox, oy = xy(o["lat"], o["lon"])
        if any(math.hypot(ox - ux, oy - uy) < 40 for ux, uy in (xy(u["lat"], u["lon"]) for u in unicos + [{"lat": p["lat"], "lon": p["lon"]} for p in postos])):
            continue
        unicos.append(o)
    sem = [{"n": o["nome"] or "Posto", "b": o["bandeira"], "end": o["end"], "lat": round(o["lat"], 6), "lon": round(o["lon"], 6),
            "m": round(math.hypot(*xy(o["lat"], o["lon"])))} for o in unicos]

    with open(cache_path + ".tmp", "w") as fh:
        json.dump(cache, fh, ensure_ascii=False)
    os.replace(cache_path + ".tmp", cache_path)
    datas = sorted(p["data"] for p in postos)
    res = {"atualizado": datetime.now(timezone.utc).isoformat(timespec="minutes"), "coleta_ate": datas[-1] if datas else None,
           "fonte": "ANP (levantamento semanal de preços, últimas 4 semanas) + OpenStreetMap", "raio_m": RAIO,
           "postos": sorted(postos, key=lambda p: p["m"]), "sem_preco": sorted(sem, key=lambda p: p["m"])}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(saida)), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, separators=(",", ":"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, saida)
    print(f'{len(postos)} postos com preço, {len(sem)} sem preço, coleta até {res["coleta_ate"]}')


if __name__ == "__main__":
    main()
