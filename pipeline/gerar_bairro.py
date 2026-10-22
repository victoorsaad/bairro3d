# Gera bairro.json: prédios, ruas, áreas e árvores no raio do config.json (padrão 1 km) e o anel de contexto,
# em metros locais (x = leste, y = norte, origem no centro do config.json).
# Uso: python3 -I gerar_bairro.py <pasta raw> <saida.json>
import json, math, os, sys, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import CFG, LAT0, LON0, RAIO, ANEL, KX, KY, xy

RAW, OUT = sys.argv[1], sys.argv[2]

def r1(v):
    return round(v, 1)

def simplificar(pts, tol=0.3):
    """Douglas-Peucker em lista de (x, y)."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    n = math.hypot(dx, dy) or 1e-9
    i, dmax = 0, 0
    for k in range(1, len(pts) - 1):
        d = abs(dy * pts[k][0] - dx * pts[k][1] + x2 * y1 - y2 * x1) / n
        if d > dmax:
            i, dmax = k, d
    if dmax <= tol:
        return [pts[0], pts[-1]]
    return simplificar(pts[: i + 1], tol)[:-1] + simplificar(pts[i:], tol)

def anel(pts):
    """Anel fechado -> lista aberta, simplificada, anti-horária."""
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return None
    # simplifica tratando como polilinha fechada a partir do ponto 0
    s = simplificar(pts + [pts[0]])[:-1]
    if len(s) < 3:
        s = pts
    area = sum(s[i][0] * s[i - 1][1] - s[i - 1][0] * s[i][1] for i in range(len(s))) / 2
    if area < 0:
        s = s[::-1]
    return s, abs(area)

def centro(pts):
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)

def plano(pts):
    return [r1(c) for p in pts for c in p]

ALTURA_MAX = 175  # acima disso costuma ser erro de digitação no OSM (a torre mais alta da região tem ~170 m)
CONFERIDAS = set(CFG.get("alturas_conferidas", []))  # nomes de prédios que podem passar do limite

def altura(tags):
    try:
        h = float(tags["height"].replace(",", ".").split()[0])
    except (KeyError, ValueError):
        try:  # sem altura: andares × 3 m + 1 m (laje e platibanda)
            h = float(tags["building:levels"].replace(",", ".").split(";")[0]) * 3 + 1
        except (KeyError, ValueError):
            return None
    return h if h <= ALTURA_MAX or tags.get("name") in CONFERIDAS else None

def aneis_osm(e):
    """Anéis externos de um way ou relation (geometria do 'out geom')."""
    if e["type"] == "way":
        return [[xy(p["lon"], p["lat"]) for p in e["geometry"]]]
    out = []
    for m in e.get("members", []):
        if m.get("role") == "outer" and m.get("geometry"):
            out.append([xy(p["lon"], p["lat"]) for p in m["geometry"]])
    return [a for a in out if len(a) > 3 and a[0] == a[-1]]

# ---------- prédios ----------
predios = []  # dicts temporários
for e in json.load(open(f"{RAW}/osm_buildings.json"))["elements"]:
    t = e.get("tags", {})
    for a in aneis_osm(e):
        r = anel(a)
        if not r:
            continue
        pts, area = r
        cx, cy = centro(pts)
        if math.hypot(cx, cy) > RAIO:
            continue
        tipo = "predio"
        if t.get("parking") == "underground" or t.get("layer", "0").startswith("-"):
            tipo = "subsolo"
        elif t.get("building") == "roof":
            tipo = "cobertura"
        predios.append({"pts": pts, "c": (cx, cy), "h": altura(t), "tipo": tipo,
                        "nome": t.get("name"), "osm": e["id"], "area": area})

for f in (json.load(open(f"{RAW}/overture_extras.json")) if os.path.exists(f"{RAW}/overture_extras.json") else []):
    g = f["geom"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    for poly in polys:
        r = anel([xy(lon, lat) for lon, lat in poly[0]])
        if not r:
            continue
        pts, area = r
        cx, cy = centro(pts)
        if math.hypot(cx, cy) > RAIO:
            continue
        predios.append({"pts": pts, "c": (cx, cy), "h": None, "tipo": "predio",
                        "nome": None, "osm": None, "area": area, "extra": True})

# altura faltando: mediana dos vizinhos com altura num raio de 40 m (fallback 6 m; extras do Overture, que são
# construções pequenas, usam 4,5 m)
com_h = [p for p in predios if p["h"]]
grade = {}
for p in com_h:
    grade.setdefault((int(p["c"][0] // 40), int(p["c"][1] // 40)), []).append(p)
estimados = 0
for p in predios:
    if p["h"]:
        continue
    estimados += 1
    if p.get("extra"):
        p["h"] = 4.5
    else:
        gx, gy = int(p["c"][0] // 40), int(p["c"][1] // 40)
        viz = [q["h"] for dx in (-1, 0, 1) for dy in (-1, 0, 1) for q in grade.get((gx + dx, gy + dy), [])
               if math.dist(q["c"], p["c"]) <= 40]
        p["h"] = statistics.median(viz) if viz else 6.0
    p["est"] = True

def predio_out(p):
    o = {"h": r1(p["h"]), "p": plano(p["pts"])}
    if p["tipo"] != "predio":
        o["t"] = p["tipo"]
    if p.get("est"):
        o["est"] = 1
    if p["nome"] and CFG.get("nomes_predios", False):   # desligado por padrão: nome de condomínio não ajuda e pode identificar alguém
        o["n"] = p["nome"]
    return o

# ---------- ruas ----------
LARG = {"motorway": 14, "trunk": 14, "primary": 12, "secondary": 10, "tertiary": 9, "residential": 7,
        "living_street": 6, "unclassified": 7, "service": 4, "pedestrian": 4, "footway": 2, "path": 1.5,
        "steps": 2, "cycleway": 2, "trunk_link": 7, "primary_link": 7, "secondary_link": 6, "tertiary_link": 6}
ruas = []
for e in json.load(open(f"{RAW}/osm_streets.json"))["elements"]:
    t = e.get("tags", {})
    hw = t.get("highway")
    if hw not in LARG or t.get("area") == "yes":
        continue
    pts = [xy(p["lon"], p["lat"]) for p in e["geometry"]]
    # corta em trechos dentro do raio (+50 m para não acabar seco na borda)
    trechos, atual = [], []
    for p in pts:
        if math.hypot(*p) <= RAIO + 50:
            atual.append(p)
        else:
            if len(atual) > 1:
                trechos.append(atual)
            atual = []
    if len(atual) > 1:
        trechos.append(atual)
    for tr in trechos:
        o = {"k": hw, "w": LARG[hw], "p": plano(simplificar(tr, 0.5))}
        if t.get("name"):
            o["n"] = t["name"]
        if t.get("bridge") == "yes":
            o["ponte"] = 1
        ruas.append(o)

# ---------- áreas ----------
def tipo_area(t):
    if t.get("leisure") in ("park", "garden"):
        return "parque"
    if t.get("leisure") == "pitch":
        return "quadra"
    if t.get("leisure") == "playground":
        return "playground"
    if t.get("landuse") in ("grass",) or t.get("natural") == "scrub":
        return "grama"
    if t.get("landuse") == "forest" or t.get("natural") == "wood":
        return "mata"
    if t.get("natural") == "water":
        return "agua"
    return None

areas = []
for e in json.load(open(f"{RAW}/osm_areas.json"))["elements"]:
    t = e.get("tags", {})
    k = tipo_area(t)
    if not k:
        continue
    for a in aneis_osm(e):
        if a[0] != a[-1]:
            continue
        r = anel(a)
        if not r:
            continue
        pts, _ = r
        if math.hypot(*centro(pts)) > RAIO + 100:
            continue
        o = {"k": k, "p": plano(pts)}
        if t.get("name"):
            o["n"] = t["name"]
        areas.append(o)

# ---------- árvores (GeoSampa) ----------
arvores = []
for f in json.load(open(f"{RAW}/geosampa_arvore.json"))["features"]:
    x, y = xy(*f["geometry"]["coordinates"][:2])
    if math.hypot(x, y) <= RAIO:
        arvores += [r1(x), r1(y)]

# ---------- anel de contexto (raio a ANEL): só prédios de 12 m ou mais, ruas, praças e trilhos ----------
contexto = {"predios": [], "ruas": [], "areas": [], "trilhos": []}
for e in json.load(open(f"{RAW}/osm_anel_predios.json"))["elements"]:
    h = altura(e.get("tags", {}))
    if not h:
        continue
    for a in aneis_osm(e):
        r = anel(a)
        if not r:
            continue
        pts, _ = r
        if RAIO < math.hypot(*centro(pts)) <= ANEL:
            o = {"h": r1(h), "p": plano(pts)}
            if e["tags"].get("name") and CFG.get("nomes_predios", False):
                o["n"] = e["tags"]["name"]
            contexto["predios"].append(o)
for e in json.load(open(f"{RAW}/osm_anel_ruas.json"))["elements"]:
    t = e.get("tags", {}); hw = t.get("highway")
    if hw not in LARG:
        continue
    trechos, atual = [], []
    for p in (xy(q["lon"], q["lat"]) for q in e["geometry"]):
        if RAIO + 40 <= math.hypot(*p) <= ANEL + 60:
            atual.append(p)
        else:
            if len(atual) > 1:
                trechos.append(atual)
            atual = []
    if len(atual) > 1:
        trechos.append(atual)
    for tr in trechos:
        contexto["ruas"].append({"k": hw, "w": LARG[hw], "p": plano(simplificar(tr, 1.0))})
for e in json.load(open(f"{RAW}/osm_anel_areas.json"))["elements"]:
    t = e.get("tags", {})
    if t.get("railway"):
        trecho = []
        for p in [xy(q["lon"], q["lat"]) for q in e["geometry"]] + [None]:   # None fecha o último trecho
            if p is not None and math.hypot(*p) <= ANEL + 60:
                trecho.append(p)
            else:
                if len(trecho) > 1:
                    contexto["trilhos"].append({"k": t["railway"], "p": plano(simplificar(trecho, 1.0))})
                trecho = []
        continue
    k = tipo_area(t)
    if not k:
        continue
    for a in aneis_osm(e):
        if a[0] != a[-1]:
            continue
        r = anel(a)
        if r and RAIO + 100 < math.hypot(*centro(r[0])) <= ANEL + 100:
            contexto["areas"].append({"k": k, "p": plano(r[0])})

saida = {
    "meta": {
        "nome": CFG["nome"], "regiao": CFG.get("regiao"), "gerado": __import__("datetime").date.today().isoformat(),
        "origem": {"lat": LAT0, "lon": LON0}, "raio_m": RAIO, "anel_m": ANEL,
        "m_por_grau": {"lon": round(KX, 3), "lat": KY},
        "eixos": "x = leste, y = norte, metros a partir do centro; p = [x0,y0,x1,y1,...]; h = altura (m)",
        "fontes": "OpenStreetMap (prédios/ruas/áreas), Overture Maps (construções extras, "
                  "altura estimada), GeoSampa (árvores)",
    },
    "predios": [predio_out(p) for p in predios],
    "ruas": ruas, "areas": areas, "arvores": arvores, "anel": contexto,
}
json.dump(saida, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"prédios {len(predios)} (estimados {estimados}) | ruas {len(ruas)} | áreas {len(areas)} | "
      f"árvores {len(arvores)//2} | anel: " + ", ".join(f"{k} {len(v)}" for k, v in contexto.items()))
