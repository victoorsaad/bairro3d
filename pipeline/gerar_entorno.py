#!/usr/bin/env python3
"""Entorno da maquete: relevo até 24 km e os lugares de destaque, campos, piscinas, trilhos e estações.

Saídas (na pasta indicada):
  entorno.json   relevo de longe (metadados), lugares com contorno, campos, piscinas, trilhos e estações
  entorno.bin    relevo de longe, Int16 em decímetros acima de base_altitude (mesma base do relevo.json)

Fontes: Copernicus DEM GLO-30 (ESA; tile de 1° que contém o centro), OpenStreetMap (Overpass).
Sem imagem de satélite: a versão pública não usa o Sentinel-2 cloudless (licença não comercial).
Uso: python3 -I gerar_entorno.py <dem.tif> <raw> <relevo.json> <saida>
     (precisa de numpy e tifffile)
"""
import json
import math
import os
import sys

import numpy as np
import tifffile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import CFG, LAT0, LON0, KX, KY  # noqa: E402

R_LONGE, PASSO_LONGE = int(CFG.get("entorno_m", 24000)), 150
BASE = None   # base_altitude do relevo.json (lida em main)


def xy(lat, lon):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def ll(x, y):
    return LAT0 + y / KY, LON0 + x / KX


# ---------- relevo ----------
def relevo(dem_path):
    a = tifffile.imread(dem_path).astype(np.float32)   # 1°x1°, linha 0 = borda norte do tile, coluna 0 = borda oeste
    LAT_N, LON_W = math.ceil(LAT0), math.floor(LON0)
    n = a.shape[0]
    k = 3                                               # DSM tem prédios: média 3x3 (~90 m) antes de amostrar
    p = np.pad(a, k // 2, mode="edge")
    a = sum(p[i:i + n, j:j + a.shape[1]] for i in range(k) for j in range(k)) / (k * k)
    N = 2 * R_LONGE // PASSO_LONGE + 1
    out = np.zeros((N, N), np.int16)
    for r in range(N):          # linha = y (sul -> norte), como o relevo.json
        y = -R_LONGE + r * PASSO_LONGE
        lat = LAT0 + y / KY
        fr = (LAT_N - lat) * n
        for c in range(N):
            x = -R_LONGE + c * PASSO_LONGE
            lon = LON0 + x / KX
            fc = (lon - LON_W) * a.shape[1]
            r0, c0 = int(fr), int(fc)
            dr, dc = fr - r0, fc - c0
            h = (a[r0, c0] * (1 - dc) + a[r0, c0 + 1] * dc) * (1 - dr) + (a[r0 + 1, c0] * (1 - dc) + a[r0 + 1, c0 + 1] * dc) * dr
            out[r, c] = int(round((h - BASE) * 10))
    return {"n": N, "passo": PASSO_LONGE, "min": -R_LONGE, "base_altitude": BASE,
            "unidade": "decímetros acima de base_altitude; linha = y (sul→norte), coluna = x (oeste→leste)",
            "fonte": "Copernicus DEM GLO-30 (ESA), média de ~90 m"}, out


# ---------- OSM ----------
def anel(geom):
    pts = []
    for p in geom:
        x, y = xy(p["lat"], p["lon"])
        pts += [round(x, 1), round(y, 1)]
    return pts


def contornos(e):
    """Lista de anéis externos [x0,y0,...] de um way fechado ou de uma relação (membros outer encadeados)."""
    if e["type"] == "way":
        return [anel(e["geometry"])] if e.get("geometry") else []
    segs = [[(p["lat"], p["lon"]) for p in m["geometry"]] for m in e.get("members", []) if m.get("role", "outer") in ("outer", "") and m.get("geometry")]
    aneis = []
    while segs:
        cur = segs.pop(0)
        mudou = True
        while cur[0] != cur[-1] and mudou:
            mudou = False
            for s in segs:
                if s[0] == cur[-1]:
                    cur += s[1:]
                elif s[-1] == cur[-1]:
                    cur += s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.remove(s)
                mudou = True
                break
        if len(cur) > 3:
            aneis.append(anel([{"lat": a, "lon": b} for a, b in cur]))
    return aneis


def area(p):
    return abs(sum(p[i] * p[(i + 3) % len(p)] - p[(i + 2) % len(p)] * p[i + 1] for i in range(0, len(p), 2))) / 2


def centro(p):
    xs, ys = p[0::2], p[1::2]
    return sum(xs) / len(xs), sum(ys) / len(ys)


# lugares que ganham destaque (nome no mapa, contorno e cartão): escolhidos pelas etiquetas do OSM
def tipo_lugar(t):
    if t.get("shop") == "mall":
        return "shopping"
    if t.get("leisure") == "stadium":
        return "estadio"
    if t.get("leisure") == "park":
        return "parque"
    if t.get("leisure") == "sports_centre":
        return "clube"
    if t.get("amenity") == "university":
        return "universidade"
    if t.get("tourism") == "museum" or t.get("amenity") in ("arts_centre", "theatre"):
        return "cultura"
    if t.get("amenity") == "marketplace":
        return "mercado"
    return None


AREA_MIN = {"parque": 15000, "clube": 8000, "shopping": 6000, "estadio": 5000, "universidade": 20000, "cultura": 1500, "mercado": 1500}
MAX_LUGARES = 24


CORES_ESPORTE = {"soccer": "futebol", "tennis": "tenis", "basketball": "quadra", "volleyball": "quadra", "multi": "quadra",
                 "futsal": "quadra", "padel": "tenis", "beachvolleyball": "areia", "skateboard": "quadra"}


def main():
    global BASE
    dem, raw, relevo_json, saida = sys.argv[1:5]
    BASE = json.load(open(relevo_json))["base_altitude"]
    detalhe, trilhos, rel = f"{raw}/osm_detalhe.json", f"{raw}/osm_trilhos.json", f"{raw}/osm_lugares.json"
    out = {"fontes": "Copernicus DEM GLO-30 (ESA); OpenStreetMap (ODbL)"}

    meta, grade = relevo(dem)
    out["relevo"] = meta
    grade.astype("<i2").tofile(os.path.join(saida, "entorno.bin"))
    print("relevo", grade.shape, grade.min() / 10, grade.max() / 10)

    lugares, nomes = [], set()
    for e in json.load(open(rel))["elements"]:
        t = e.get("tags", {})
        tipo, nome = tipo_lugar(t), t.get("name")
        if not tipo or not nome or nome in nomes:
            continue
        cs = [c for c in contornos(e) if len(c) >= 8]
        if not cs:
            continue
        maior = max(cs, key=area)
        if area(maior) < AREA_MIN[tipo]:
            continue
        cx, cy = centro(maior)
        nomes.add(nome)
        lugares.append({"id": f'{e["type"][0]}{e["id"]}', "n": nome, "t": tipo, "x": round(cx), "y": round(cy),
                        "m": round(math.hypot(cx, cy)), "area": round(area(maior)), "p": cs})
    # os maiores e mais perto primeiro, sem passar de MAX_LUGARES
    lugares.sort(key=lambda l: l["m"] / math.sqrt(l["area"]))
    out["lugares"] = sorted(lugares[:MAX_LUGARES], key=lambda l: l["m"])

    campos, piscinas, pistas = [], [], []
    for e in json.load(open(detalhe))["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or not e.get("geometry") or e["geometry"][0] != e["geometry"][-1]:
            continue
        p = anel(e["geometry"])
        cx, cy = centro(p)
        if math.hypot(cx, cy) > 2700:
            continue
        lz = t.get("leisure")
        if lz == "pitch":
            esp = (t.get("sport") or "").split(";")[0]
            k = CORES_ESPORTE.get(esp, "quadra")
            if t.get("surface") in ("grass", "artificial_turf") and k != "tenis":
                k = "futebol"
            if t.get("surface") in ("clay",):
                k = "tenis"
            campos.append({"k": k, "p": p})
        elif lz == "swimming_pool" or t.get("natural") == "water":
            if area(p) >= 12:
                piscinas.append(p)
        elif lz == "track":
            pistas.append(p)
    out["campos"], out["piscinas"], out["pistas"] = campos, piscinas, pistas

    linhas, estacoes = [], []
    for e in json.load(open(trilhos))["elements"]:
        t = e.get("tags", {})
        if e["type"] == "way" and t.get("railway") in ("subway", "rail") and e.get("geometry"):
            if t.get("service") in ("yard", "siding", "spur") or t.get("usage") == "industrial":
                continue
            linhas.append({"k": "metro" if t["railway"] == "subway" else "trem", "tunel": t.get("tunnel") == "yes",
                           "p": anel(e["geometry"])})
        elif e["type"] == "node" and t.get("railway") == "station":
            x, y = xy(e["lat"], e["lon"])
            estacoes.append({"n": t.get("name", "").split(" – ")[0].split(" - ")[0], "x": round(x), "y": round(y),
                             "k": "metro" if t.get("station") == "subway" or t.get("subway") == "yes" else "trem",
                             "m": round(math.hypot(x, y))})
    out["trilhos"], out["estacoes"] = linhas, sorted(estacoes, key=lambda s: s["m"])

    with open(os.path.join(saida, "entorno.json"), "w") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f'{len(out["lugares"])} lugares, {len(campos)} campos, {len(piscinas)} piscinas, {len(pistas)} pistas, {len(linhas)} trilhos, {len(estacoes)} estações')


if __name__ == "__main__":
    main()
