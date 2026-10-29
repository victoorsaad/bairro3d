"""Dados ao vivo da maquete: o servidor busca na fonte, recorta em volta do centro do config.json e guarda em cache.

O navegador só fala com o próprio site (CSP connect-src 'self'); chaves de API ficam aqui, lidas do ambiente.
Cada fonte tem um TTL: dentro dele a resposta sai do cache, sem tocar na fonte. Se a fonte cair, a última resposta boa
continua valendo por até 10 TTLs.

Fontes:
  bike   Bike Itaú (Tembici), GBFS público: estações a até anel_m do centro, com bicicletas e vagas livres
  voos   adsb.lol (ADS-B comunitário, ODbL): aviões num raio de 25 milhas náuticas
  clima  Open-Meteo (CC BY 4.0): tempo agora em Pinheiros
  transito  TomTom (chave do plano grátis em TOMTOM_KEY): velocidade relativa por trecho (tiles "flow relative", zoom 14,
            3×3 em volta do centro) + interdições, acidentes e obras. 5 min de cache: ~2,6 mil tiles e 288 consultas por
            dia, longe dos limites grátis (50 mil tiles, 2,5 mil consultas)
"""
import concurrent.futures
import json
import math
import os
import threading
import time
import urllib.parse
import urllib.request

import mvt

CONFIG = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json"), encoding="utf-8"))
LAT, LON = CONFIG["lat"], CONFIG["lon"]
UA = "bairro3d/1.0 (+https://bairro3d.saadcloud.com.br)"
GBFS = "https://saopaulo.publicbikesystem.net/customer/gbfs/v2/pt/"


def baixar(url, timeout=8, binario=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*" if binario else "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read() if binario else json.load(r)


def metros(lat, lon):
    """x leste, y norte em metros a partir do centro, só para recortar o raio (o navegador converte com o bairro.json)."""
    return ((lon - LON) * 111320 * math.cos(math.radians(LAT)), (lat - LAT) * 110574)


_info_bike = {"t": 0, "d": None}


def bike():
    if time.time() - _info_bike["t"] > 6 * 3600 or not _info_bike["d"]:
        info = baixar(GBFS + "station_information")["data"]["stations"]
        tipos = baixar(GBFS + "vehicle_types")["data"]["vehicle_types"]
        _info_bike["d"] = (info, {t["vehicle_type_id"] for t in tipos if t.get("propulsion_type", "human") != "human"})
        _info_bike["t"] = time.time()
    info, eletricas = _info_bike["d"]
    st = {s["station_id"]: s for s in baixar(GBFS + "station_status")["data"]["stations"]}
    out = []
    for e in info:
        x, y = metros(e["lat"], e["lon"])
        if math.hypot(x, y) > CONFIG["anel_m"]:
            continue
        s = st.get(e["station_id"])
        if not s:
            continue
        ele = sum(v["count"] for v in s.get("vehicle_types_available") or [] if v["vehicle_type_id"] in eletricas)
        nome = e["name"].split(" - ", 1)[-1]
        out.append({"id": e["station_id"], "n": nome, "end": e.get("address") or "", "lat": e["lat"], "lon": e["lon"],
                    "cap": e.get("capacity"), "b": s.get("num_bikes_available", 0), "e": ele, "v": s.get("num_docks_available", 0),
                    "ok": bool(s.get("is_renting")) and s.get("status") == "IN_SERVICE", "t": s.get("last_reported")})
    return {"fonte": "Bike Itaú (Tembici) · GBFS", "estacoes": out}


def voos():
    d = baixar("https://api.adsb.lol/v2/point/%.4f/%.4f/25" % (LAT, LON))
    out = []
    for a in d.get("ac") or []:
        if a.get("lat") is None or a.get("alt_baro") in (None, "ground"):
            continue
        alt = a.get("alt_geom") or a["alt_baro"]
        out.append({"hex": a["hex"], "voo": (a.get("flight") or "").strip(), "reg": a.get("r") or "", "tipo": a.get("t") or "",
                    "lat": a["lat"], "lon": a["lon"], "alt": round(alt * .3048), "vel": round((a.get("gs") or 0) * .5144, 1),
                    "rumo": a.get("track"), "sobe": round((a.get("baro_rate") or 0) * .00508, 1), "visto": a.get("seen_pos", 0)})
    return {"fonte": "adsb.lol", "agora": d.get("now"), "avioes": out}


def clima():
    d = baixar("https://api.open-meteo.com/v1/forecast?latitude=%.4f&longitude=%.4f&timezone=America%%2FSao_Paulo"
               "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,"
               "wind_speed_10m,wind_direction_10m,is_day&hourly=precipitation_probability&forecast_hours=6" % (LAT, LON))
    c = d["current"]
    return {"fonte": "Open-Meteo", "hora": c["time"], "temp": c["temperature_2m"], "sensacao": c["apparent_temperature"],
            "umidade": c["relative_humidity_2m"], "chuva_mm": c["precipitation"], "codigo": c["weather_code"],
            "nuvens": c["cloud_cover"], "vento_kmh": c["wind_speed_10m"], "vento_dir": c["wind_direction_10m"], "dia": c["is_day"],
            "chuva_prob_6h": max(d.get("hourly", {}).get("precipitation_probability") or [0])}


TIPO_INC = {1: "acidente", 2: "neblina", 3: "perigo", 4: "chuva", 5: "gelo", 7: "faixa fechada", 8: "via interditada", 9: "obra",
            10: "vento", 11: "alagamento", 14: "veículo quebrado"}   # 6 = congestionamento, já está nas cores do trânsito


def transito():
    chave = os.environ.get("TOMTOM_KEY")
    if not chave:
        raise RuntimeError("sem TOMTOM_KEY")
    z = 14
    n = 2 ** z
    lr = math.radians(LAT)
    tx0, ty0 = int((LON + 180) / 360 * n), int((1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n)
    lim = CONFIG["anel_m"] + 50
    linhas = []
    tiles = [(tx0 + dx, ty0 + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)]
    with concurrent.futures.ThreadPoolExecutor(9) as ex:
        brutos = list(ex.map(lambda t: baixar("https://api.tomtom.com/traffic/map/4/tile/flow/relative/%d/%d/%d.pbf?key=%s" % (z, t[0], t[1], chave), binario=True), tiles))
    for (tx, ty), dados in zip(tiles, brutos):
        ext, feats = mvt.ler(dados).get("Traffic flow", (4096, []))
        for props, geo in feats:
            nivel = props.get("traffic_level")
            if not isinstance(nivel, (int, float)) or nivel < 0:
                continue
            larga = any(k in (props.get("road_type") or "") for k in ("Major road", "Secondary", "International", "Major local", "Connecting"))
            for anel in geo:
                p = []
                for x, y in anel:
                    lon = (tx + x / ext) / n * 360 - 180
                    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + y / ext) / n))))
                    if math.hypot(*metros(lat, lon)) > lim:
                        if len(p) >= 4:
                            linhas.append({"n": round(nivel, 2), "w": 1 if larga else 0, "f": bool(props.get("road_closure")), "p": p})
                        p = []
                        continue
                    p += [round(lat, 5), round(lon, 5)]
                if len(p) >= 4:
                    linhas.append({"n": round(nivel, 2), "w": 1 if larga else 0, "f": bool(props.get("road_closure")), "p": p})
    dlat, dlon = CONFIG["anel_m"] / 110574, CONFIG["anel_m"] / (111320 * math.cos(lr))
    campos = "{incidents{type,geometry{type,coordinates},properties{iconCategory,magnitudeOfDelay,events{description},startTime,endTime,from,to,length,delay}}}"
    inc = baixar("https://api.tomtom.com/traffic/services/5/incidentDetails?key=%s&bbox=%f,%f,%f,%f&language=pt-PT&timeValidityFilter=present&fields=%s"
                 % (chave, LON - dlon, LAT - dlat, LON + dlon, LAT + dlat, urllib.parse.quote(campos)))
    incidentes = []
    for i in inc.get("incidents") or []:
        pr, g = i["properties"], i["geometry"]
        tipo = TIPO_INC.get(pr.get("iconCategory"))
        if not tipo:
            continue
        cs = g["coordinates"] if g["type"] == "LineString" else [g["coordinates"]] if g["type"] == "Point" else [c for l in g["coordinates"] for c in l]
        lon, lat = cs[len(cs) // 2]
        if math.hypot(*metros(lat, lon)) > CONFIG["anel_m"]:
            continue
        incidentes.append({"tipo": tipo, "lat": lat, "lon": lon, "linha": [round(v, 6) for c in cs for v in (c[1], c[0])] if len(cs) > 1 else [],
                           "de": pr.get("from") or "", "ate": pr.get("to") or "", "desc": " · ".join(e["description"] for e in pr.get("events") or [] if e.get("description")),
                           "inicio": pr.get("startTime"), "fim": pr.get("endTime"), "atraso": pr.get("delay"), "metros": pr.get("length")})
    return {"fonte": "TomTom", "linhas": linhas, "incidentes": incidentes}


FONTES = {"bike": (bike, 60), "voos": (voos, 10), "clima": (clima, 600), "transito": (transito, 300)}
_cache = {}
_travas = {k: threading.Lock() for k in FONTES}


def ttl(fonte):
    return FONTES[fonte][1] if fonte in FONTES else 60


def pegar(fonte):
    """(bytes ou None, idade em s, ttl) ou None se a fonte não existe."""
    if fonte not in FONTES:
        return None
    f, t = FONTES[fonte]
    c = _cache.get(fonte)
    if c and time.time() - c[0] < t:
        return c[1], time.time() - c[0], t
    with _travas[fonte]:   # uma busca por vez na fonte; quem chega junto espera e usa o resultado
        c = _cache.get(fonte)
        if c and time.time() - c[0] < t:
            return c[1], time.time() - c[0], t
        try:
            dados = json.dumps(f(), ensure_ascii=False, separators=(",", ":")).encode()
            _cache[fonte] = (time.time(), dados)
            return dados, 0, t
        except Exception as e:  # fonte fora do ar ou mudou de formato: segura a última resposta boa
            print("aovivo %s: %s" % (fonte, e), flush=True)
            if c and time.time() - c[0] < 10 * t:
                return c[1], time.time() - c[0], t
            return None, 0, t
