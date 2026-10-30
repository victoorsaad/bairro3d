"""Dados ao vivo da maquete: o servidor busca na fonte, recorta em volta do centro do config.json e guarda em cache.

O navegador só fala com o próprio site (CSP connect-src 'self'); chaves de API ficam aqui, lidas do ambiente.
Cada fonte tem um TTL: dentro dele a resposta sai do cache, sem tocar na fonte. Se a fonte cair, a última resposta boa
continua valendo por até 10 TTLs.

Fontes:
  bike   Bike Itaú (Tembici), GBFS público: estações a até anel_m do centro, com bicicletas e vagas livres
  voos   adsb.lol (ADS-B comunitário, ODbL): aviões num raio de 25 milhas náuticas
  clima  Open-Meteo (CC BY 4.0): tempo agora em Pinheiros
  foto      Mapillary (CC BY-SA 4.0, token em MAPILLARY_TOKEN): fotos de rua perto de um ponto (/api/foto?lat=&lon=) e a
            imagem em si (/api/foto/<id>.jpg), passada pelo servidor porque a CSP só deixa carregar imagem do próprio site
  noticias  Google News (RSS público, sem chave): manchetes dos últimos 7 dias que citam Pinheiros ou o Largo da Batata
  onibus    SPTrans Olho Vivo (token em SPTRANS_TOKEN, só HTTPS): posição GPS de todos os ônibus da cidade, guardada 20 s,
            e cada pedido recorta em volta de um ponto (/api/onibus, ou ?lat=&lon= para outro centro dentro de SP);
            cada ônibus vem com até 2 leituras anteriores (h), para o navegador já mostrar o trajeto
  transito  TomTom (chave do plano grátis em TOMTOM_KEY): velocidade relativa por trecho (tiles "flow relative", zoom 14,
            3×3 em volta do centro) + interdições, acidentes e obras. 5 min de cache: ~2,6 mil tiles e 288 consultas por
            dia, longe dos limites grátis (50 mil tiles, 2,5 mil consultas)
"""
import collections
import concurrent.futures
import json
import math
import os
import threading
import time
import email.utils
import re
import urllib.parse
import xml.etree.ElementTree as ET
import urllib.error
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


def noticias():
    q = '"Pinheiros" OR "Largo da Batata" São Paulo when:7d'   # "Faria Lima" puxa notícia de mercado financeiro
    req = urllib.request.Request("https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q, "hl": "pt-BR", "gl": "BR", "ceid": "BR:pt-419"}),
                                 headers={"User-Agent": "Mozilla/5.0 (" + UA + ")"})
    with urllib.request.urlopen(req, timeout=10) as r:
        raiz = ET.fromstring(r.read(2_000_000))
    out, vistos = [], set()
    for it in raiz.findall("./channel/item"):
        titulo, fonte = (it.findtext("title") or "").strip(), (it.findtext("source") or "").strip()
        if fonte and titulo.endswith(" - " + fonte):
            titulo = titulo[: -len(fonte) - 3]
        if not re.search(r"Pinheiros|Largo da Batata", titulo) or titulo in vistos:
            continue
        vistos.add(titulo)
        link = it.findtext("link") or ""
        if not link.startswith("https://"):
            continue
        try:
            quando = int(email.utils.parsedate_to_datetime(it.findtext("pubDate")).timestamp())
        except Exception:
            quando = 0
        out.append({"t": titulo, "f": fonte, "u": link, "q": quando})
    out.sort(key=lambda n: -n["q"])
    return {"fonte": "Google News", "noticias": out[:15]}


class Lru:
    """Cache pequeno com validade: chave -> (instante, valor); os mais antigos saem quando passa do limite."""
    def __init__(self, maximo, ttl):
        self.d, self.maximo, self.ttl, self.trava = collections.OrderedDict(), maximo, ttl, threading.Lock()

    def get(self, k):
        with self.trava:
            v = self.d.get(k)
            if v and time.time() - v[0] < self.ttl:
                self.d.move_to_end(k)
                return v[1]
        return None

    def put(self, k, v):
        with self.trava:
            self.d[k] = (time.time(), v)
            self.d.move_to_end(k)
            while len(self.d) > self.maximo:
                self.d.popitem(last=False)


_fotos, _imgs = Lru(3000, 86400), Lru(150, 6 * 3600)
MLY = "https://graph.mapillary.com/"


def foto(lat, lon):
    """Até 8 fotos a no máximo ~60 m do ponto, da mais perto para a mais longe (empate: a mais nova)."""
    chave = os.environ.get("MAPILLARY_TOKEN")
    if not chave or not (-90 <= lat <= 90 and -180 <= lon <= 180) or math.hypot(*metros(lat, lon)) > CONFIG["anel_m"] + 300:
        return None
    k = (round(lat, 4), round(lon, 4))
    r = _fotos.get(k)
    if r is not None:
        return r
    d = 0.0006
    q = urllib.parse.urlencode({"access_token": chave, "fields": "id,captured_at,compass_angle,computed_compass_angle,geometry,is_pano,creator",
                                "bbox": "%f,%f,%f,%f" % (lon - d, lat - d, lon + d, lat + d), "limit": 200})
    out = []
    for x in baixar(MLY + "images?" + q, timeout=15).get("data") or []:
        flon, flat = x["geometry"]["coordinates"]
        dx, dy = metros(flat, flon)
        px, py = metros(lat, lon)
        out.append({"id": x["id"], "lat": flat, "lon": flon, "m": round(math.hypot(dx - px, dy - py), 1),
                    "ang": x.get("computed_compass_angle") or x.get("compass_angle"), "q": x.get("captured_at", 0) // 1000,
                    "pano": bool(x.get("is_pano")), "autor": (x.get("creator") or {}).get("username", "")})
    out.sort(key=lambda f: (round(f["m"] / 8), -f["q"]))
    r = json.dumps({"fonte": "Mapillary", "fotos": out[:8]}, separators=(",", ":")).encode()
    _fotos.put(k, r)
    return r


def foto_img(ident):
    chave = os.environ.get("MAPILLARY_TOKEN")
    if not chave or not ident.isdigit() or len(ident) > 20:
        return None
    r = _imgs.get(ident)
    if r is None:
        url = baixar(MLY + ident + "?" + urllib.parse.urlencode({"access_token": chave, "fields": "thumb_1024_url"})).get("thumb_1024_url")
        if not url or not url.startswith("https://"):
            return None
        r = baixar(url, timeout=15, binario=True)
        _imgs.put(ident, r)
    return r


OLHO_VIVO = "https://api.olhovivo.sptrans.com.br/v2.1/"
_ov = {"op": None, "t": 0, "d": None, "trava": threading.Lock()}
_ov_hist = {}   # prefixo → últimas leituras [(lat, lon, horário)], para o navegador já começar com o ônibus andando


def _ov_login():
    chave = os.environ.get("SPTRANS_TOKEN")
    if not chave:
        return None
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
    req = urllib.request.Request(OLHO_VIVO + "Login/Autenticar?token=" + urllib.parse.quote(chave), data=b"",
                                 headers={"User-Agent": UA}, method="POST")
    with op.open(req, timeout=10) as r:
        if r.read().strip() != b"true":
            raise RuntimeError("Olho Vivo recusou o token")
    return op


def _ov_posicoes():
    """Todos os ônibus com GPS da cidade: [(lat, lon, prefixo, linha, destino, horário)]. Cache de 20 s."""
    with _ov["trava"]:
        if _ov["d"] is not None and time.time() - _ov["t"] < 20:
            return _ov["d"]
        for tentativa in range(2):              # sessão expirada volta 401: faz login de novo uma vez
            if _ov["op"] is None:
                _ov["op"] = _ov_login()
                if _ov["op"] is None:
                    return None
            try:
                req = urllib.request.Request(OLHO_VIVO + "Posicao", headers={"User-Agent": UA, "Accept": "application/json"})
                with _ov["op"].open(req, timeout=15) as r:
                    d = json.load(r)
                break
            except urllib.error.HTTPError as e:
                _ov["op"] = None
                if e.code != 401 or tentativa:
                    raise
        out = []
        for l in d.get("l") or []:
            destino = l.get("lt1") if l.get("sl") == 1 else l.get("lt0")
            for v in l.get("vs") or []:
                out.append((v["py"], v["px"], v["p"], l.get("c", ""), destino or "", v.get("ta", "")))
        vistos = set()
        for a, o, p, c, dest, t in out:
            h = _ov_hist.setdefault(p, [])
            if not h or h[-1][2] != t:
                h.append((a, o, t))
                del h[:-3]
            vistos.add(p)
        for p in [p for p in _ov_hist if p not in vistos]:      # sumiu da API (recolheu): esquece
            del _ov_hist[p]
        _ov["d"], _ov["t"] = out, time.time()
        return out


def onibus(lat=None, lon=None):
    """Ônibus a até anel_m do centro (ou do ponto pedido, que precisa estar em São Paulo)."""
    if lat is None:
        lat, lon = LAT, LON
    elif not (-24.1 < lat < -23.3 and -47.0 < lon < -46.3):
        return None
    todos = _ov_posicoes()
    if todos is None:
        return None
    kx, ky, r = 111320 * math.cos(math.radians(lat)), 110574, CONFIG["anel_m"]
    out = [{"p": p, "l": c, "d": d, "lat": a, "lon": o, "ta": t, "h": [list(x) for x in _ov_hist.get(p, [])[:-1]]} for a, o, p, c, d, t in todos
           if abs(a - lat) * ky < r and abs(o - lon) * kx < r and math.hypot((a - lat) * ky, (o - lon) * kx) < r]
    return json.dumps({"fonte": "SPTrans Olho Vivo", "idade": int(time.time() - _ov["t"]), "onibus": out},
                      separators=(",", ":"), ensure_ascii=False).encode()


FONTES = {"noticias": (noticias, 1800), "bike": (bike, 60), "voos": (voos, 10), "clima": (clima, 600), "transito": (transito, 300)}
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
