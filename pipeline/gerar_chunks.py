# Chunks do anel (raio a anel do config.json, padrão 1 a 2,3 km): casas e prédios baixos + árvores, em quadrados de 500 m que o navegador carrega
# conforme a câmera chega perto. O bairro.json continua com o raio de 1 km completo e, no anel, só as torres (≥ 12 m),
# que servem de "longe"; os chunks acrescentam o resto sem repetir essas torres.
#   1. contornos de edificação do GeoSampa (WFS edificacao, base de 2007, mais completa que o OSM para casas; cache em
#      raw/geosampa_edif_anel_*.json) com altura e cor medidas no LiDAR 2020; contorno sem nada construído em 2020 sai;
#   2. manchas de edificação do LiDAR fora de qualquer contorno viram construções novas (como no lidar_predios.py);
#   3. árvores do GeoSampa (WFS arvore, cache em raw/geosampa_arvore_anel.json).
# Saída: <pasta>/index.json + <pasta>/c_<i>_<j>.json (i = coluna leste, j = linha norte; quadrado de TAM m a partir do centro).
# Uso: python3 -I gerar_chunks.py <bairro.json> <raw> <lidar_grade.npz|-> <pasta de saída>
#   (sem a grade do LiDAR, "-": as alturas vêm do GeoSampa e, na falta, ficam estimadas em 6 m)
# Requer: numpy, scipy, scikit-image, shapely
import sys, os, json, math, time, urllib.request, urllib.parse
import numpy as np
from scipy import ndimage as ndi
from skimage.draw import polygon as rasterizar
from skimage.measure import find_contours
from shapely.geometry import Polygon, Point
from shapely.strtree import STRtree

BJ, RAW, GRADE, OUT = sys.argv[1:5]
TAM = 500
B = json.load(open(BJ)); M = B["meta"]; o, k = M["origem"], M["m_por_grau"]
RAIO, ANEL = M["raio_m"], M["anel_m"]
LAT0, LON0 = o["lat"], o["lon"]
xy = lambda lon, lat: ((lon - LON0) * k["lon"], (lat - LAT0) * k["lat"])
H = {"User-Agent": "bairro3d-publico/1.0 (maquete 3D com dados abertos)"}
os.makedirs(OUT, exist_ok=True)

def baixa(arq, url, corpo=None):
    if os.path.exists(arq): return json.load(open(arq))
    for t in range(5):
        try:
            req = urllib.request.Request(url, data=corpo.encode() if corpo else None, headers=H)
            d = json.load(urllib.request.urlopen(req, timeout=300)); break
        except Exception as e:
            if t == 4: raise
            print("tentando de novo", e, flush=True); time.sleep(20)
    json.dump(d, open(arq, "w")); return d

dlat, dlon = (ANEL + 150) / k["lat"], (ANEL + 150) / k["lon"]
bb = (LAT0 - dlat, LON0 - dlon, LAT0 + dlat, LON0 + dlon)
def wfs(camada, cache):
    fs = []
    for i in range(0, 1000000, 5000):     # paginado
        pag = baixa(f"{RAW}/{cache}_{i}.json",
                    "https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature"
                    f"&typeNames=geoportal:{camada}&srsName=EPSG:4326&outputFormat=application/json&count=5000&sortBy=cd_identificador"
                    + (f"&startIndex={i}" if i else "") + f"&bbox={bb[0]},{bb[1]},{bb[2]},{bb[3]},urn:ogc:def:crs:EPSG::4326")
        fs += pag.get("features", [])
        print(camada, len(fs), flush=True)
        if len(pag.get("features", [])) < 5000: return fs
edif = wfs("edificacao", "geosampa_edif_anel")
arv = wfs("arvore", "geosampa_arvore_anel")

# ---------- LiDAR ----------
if os.path.exists(GRADE):
    G = np.load(GRADE); bld, chao, R = G["bld"], G["chao"], int(G["R"]); N = 2 * R
    RGB = G["rgb"] if "rgb" in G else None
else:   # sem LiDAR: grade vazia (nada medido, nenhuma construção nova)
    R = ANEL + 100; N = 2 * R
    bld = np.full((N, N), np.nan, np.float32); chao = np.zeros((N, N), np.float32); RGB = None
kk = 5
c5 = chao[: N // kk * kk, : N // kk * kk].reshape(N // kk, kk, N // kk, kk)
with np.errstate(all="ignore"): c5 = np.nanmedian(c5, axis=(1, 3))
_, (ii, jj) = ndi.distance_transform_edt(~np.isfinite(c5), return_indices=True)
dtm = ndi.zoom(ndi.uniform_filter(c5[ii, jj], 3), kk, order=1)[:N, :N]
ndsm = bld - dtm
lidar_ok = ndi.binary_dilation(ndi.binary_closing(np.isfinite(chao) | np.isfinite(bld), iterations=3), iterations=2)
if not os.path.exists(GRADE): lidar_ok[:] = False
ocupado = np.zeros((N, N), bool)

def celulas(pts):
    xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
    return rasterizar(ys + R, xs + R, (N, N))
def cor_telhado(rr, cc):
    if RGB is None: return None
    v = RGB[rr, cc]; v = v[v.sum(1) > 0]
    if len(v) < 4: return None
    return "%02x%02x%02x" % tuple(int(x) for x in np.median(v, 0))
def anel_ccw(pts, tol=.3):
    if pts[0] == pts[-1]: pts = pts[:-1]
    if len(pts) < 3: return None
    p = Polygon(pts).buffer(0)
    if p.geom_type != "Polygon" or p.area < 6: return None
    p = p.simplify(tol)
    if p.geom_type != "Polygon" or p.area < 6: return None
    s = list(p.exterior.coords)[:-1]
    a2 = sum(s[i][0] * s[i - 1][1] - s[i - 1][0] * s[i][1] for i in range(len(s)))
    return s[::-1] if a2 < 0 else s          # mesma orientação do gerar_bairro.py
plano = lambda pts: [round(c, 1) for p in pts for c in p]
centro = lambda pts: (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

# torres do anel que já estão no bairro.json: ocupam a grade e não se repetem nos chunks
base = []
for b in B["anel"]["predios"]:
    pts = list(zip(b["p"][0::2], b["p"][1::2]))
    rr, cc = celulas(pts); ocupado[rr, cc] = True
    try: base.append(Polygon(pts).buffer(0))
    except Exception: pass
arv_base = STRtree(base)
def repete(pg):
    c = pg.representative_point()
    return any(base[j].contains(c) or pg.contains(base[j].representative_point()) for j in arv_base.query(pg))

def aneis(g):
    if not g: return []
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"] if g["type"] == "MultiPolygon" else []
    return [[xy(*c[:2]) for c in p[0]] for p in polys]

predios, st = [], {"geosampa": 0, "demolidos": 0, "repetidos": 0, "medidos": 0, "novos": 0}
for e in edif:
    t = e.get("properties", {})
    for a in aneis(e.get("geometry")):
        if len(a) < 4: continue
        pts = anel_ccw(a)
        if not pts: continue
        cx, cy = centro(pts); d = math.hypot(cx, cy)
        if not (RAIO < d <= ANEL + 50): continue
        pg = Polygon(pts)
        rr, cc = celulas(pts)
        if len(rr): ocupado[rr, cc] = True
        if repete(pg): st["repetidos"] += 1; continue
        b = {"p": plano(pts)}
        tipo = None
        h = t.get("qt_altura_edificacao") or None
        if h and h > 120: h = None
        if len(rr) and lidar_ok[rr, cc].mean() > .9 and not tipo:
            v = ndsm[rr, cc]; v = v[np.isfinite(v) & (v > 1.5)]
            cob = len(v) / len(rr)
            if cob < .05 and len(rr) >= 30: st["demolidos"] += 1; continue
            if cob >= .25 and len(v) >= 4: h = float(np.percentile(v, 55)); b["l"] = 1; st["medidos"] += 1
            c = cor_telhado(rr, cc)
            if c: b["c"] = c
        if h is None: h, b["est"] = 6.0, 1
        if h >= 12 and not tipo: b["torre"] = 1      # torre sem altura no OSM (não estava no anel do bairro.json)
        b["h"] = round(h, 1)
        predios.append(b); st["geosampa"] += 1

# manchas do LiDAR fora de qualquer contorno
m = np.isfinite(ndsm) & (ndsm > 2.5) & ~ndi.binary_dilation(ocupado, iterations=2)
yy, xx = np.mgrid[0:N, 0:N]
dd = np.hypot(xx - R + .5, yy - R + .5)
m &= (dd > RAIO - 30) & (dd <= ANEL + 60)
del yy, xx, dd
m = ndi.binary_opening(m, iterations=1)
lab, n = ndi.label(m, structure=np.ones((3, 3)))
def contorno(mask):
    cs = find_contours(np.pad(mask, 1).astype(float), .5)
    if not cs: return None
    pol = Polygon([(x - 1, y - 1) for y, x in max(cs, key=len)]).buffer(0)
    pol = pol.simplify(1.4 if pol.area > 300 else .8).buffer(0)
    return pol if pol.geom_type == "Polygon" and pol.area >= 20 else None
for idx, sl in enumerate(ndi.find_objects(lab), 1):
    if sl is None: continue
    sub = lab[sl] == idx
    if int(sub.sum()) < 30: continue
    v = np.where(sub, ndsm[sl], np.nan); h = float(np.nanpercentile(v, 55))
    pol = contorno(sub)
    if pol is None: continue
    y0, x0 = sl[0].start, sl[1].start
    pts = anel_ccw([(x0 + x - R + .5, y0 + y - R + .5) for x, y in pol.exterior.coords[:-1]], .01)
    if not pts: continue
    cx, cy = centro(pts)
    if not (RAIO < math.hypot(cx, cy) <= ANEL + 50): continue
    b = {"h": round(h, 1), "p": plano(pts), "novo": 1, "l": 1}
    rr, cc = np.nonzero(sub); c = cor_telhado(rr + y0, cc + x0)
    if c: b["c"] = c
    if h >= 12: b["torre"] = 1
    predios.append(b); st["novos"] += 1
print(st, "total", len(predios), flush=True)

# ---------- árvores ----------
arvores = []
for f in arv:
    if not f.get("geometry"): continue
    x, y = xy(*f["geometry"]["coordinates"][:2])
    if RAIO < math.hypot(x, y) <= ANEL + 50: arvores.append((round(x, 1), round(y, 1)))

# ---------- chunks ----------
cel = {}
for b in predios:
    cx, cy = centro(list(zip(b["p"][0::2], b["p"][1::2])))
    cel.setdefault((math.floor(cx / TAM), math.floor(cy / TAM)), {"predios": [], "arvores": []})["predios"].append(b)
for x, y in arvores:
    cel.setdefault((math.floor(x / TAM), math.floor(y / TAM)), {"predios": [], "arvores": []})["arvores"] += [x, y]
for f in os.listdir(OUT):
    if f.startswith("c_") and f.endswith(".json"): os.remove(f"{OUT}/{f}")
idx, total = [], 0
for (i, j), c in sorted(cel.items()):
    s = json.dumps(c, ensure_ascii=False, separators=(",", ":"))
    open(f"{OUT}/c_{i}_{j}.json", "w").write(s); total += len(s)
    idx.append([i, j, len(c["predios"]), len(c["arvores"]) // 2])
json.dump({"tam": TAM, "raio": RAIO, "anel": ANEL, "gerado": time.strftime("%Y-%m-%d"),
           "fontes": "GeoSampa (contornos de edificação)" + (" + LiDAR 2020 da PMSP (alturas, cor do telhado e construções fora do OSM)" if os.path.exists(GRADE) else "") + "; árvores do GeoSampa",
           "cel": idx}, open(f"{OUT}/index.json", "w"), separators=(",", ":"))
print("chunks", len(idx), "árvores", len(arvores), f"{total/1e6:.1f} MB", "maior", max(i[2] for i in idx), "prédios")
