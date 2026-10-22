# Atualiza os prédios do bairro.json com o LiDAR 2020 da PMSP (grade de lidar_grade.py):
#  1. altura medida de cada contorno existente (mediana do telhado menos o chão em volta);
#  2. contornos sem nenhum ponto de edificação viram "demolidos" e saem;
#  3. manchas de edificação fora de qualquer contorno viram prédios novos (contorno tirado da própria grade).
# Uso: python3 -I lidar_predios.py <bairro.json> <lidar_grade.npz> <saida.json>
# Requer: numpy, scipy, scikit-image, shapely
import sys, json, math
import numpy as np
from scipy import ndimage as ndi
from skimage.draw import polygon as rasterizar
from skimage.measure import find_contours
from shapely.geometry import Polygon

ENT, GRADE, OUT = sys.argv[1:4]
B = json.load(open(ENT))
G = np.load(GRADE); bld, chao, R = G["bld"], G["chao"], int(G["R"]); N = 2 * R
RGB = G["rgb"] if "rgb" in G else None

def cor_telhado(rr, cc):
    """Cor mediana do telhado (foto aérea do LiDAR) como "rrggbb", ou None."""
    if RGB is None: return None
    v = RGB[rr, cc]; v = v[v.sum(1) > 0]
    if len(v) < 4: return None
    return "%02x%02x%02x" % tuple(int(x) for x in np.median(v, 0))
RAIO, ANEL = B["meta"]["raio_m"], B["meta"]["anel_m"]

# ---------- terreno: mínimo do chão em blocos de 5 m, buracos (embaixo dos prédios) preenchidos pelo vizinho mais perto ----------
k = 5
c5 = chao[: N // k * k, : N // k * k].reshape(N // k, k, N // k, k)
with np.errstate(all="ignore"):
    c5 = np.nanmedian(c5, axis=(1, 3))
falta = ~np.isfinite(c5)
_, (ii, jj) = ndi.distance_transform_edt(falta, return_indices=True)
c5 = c5[ii, jj]
c5 = ndi.uniform_filter(c5, 3)          # suaviza a emenda
dtm = ndi.zoom(c5, k, order=1)[:N, :N]
ndsm = bld - dtm
lidar_ok = np.isfinite(chao) | np.isfinite(bld)    # célula coberta por alguma folha
lidar_ok = ndi.binary_dilation(ndi.binary_closing(lidar_ok, iterations=3), iterations=2)

def celulas(p):
    xs, ys = np.array(p[0::2]), np.array(p[1::2])
    rr, cc = rasterizar(ys + R, xs + R, (N, N))
    return rr, cc

ocupado = np.zeros((N, N), bool)
stats = {"medidos": 0, "demolidos": 0, "sem_lidar": 0, "novos": 0, "novos_anel": 0}

def medir(lista, h_min=None):
    fica = []
    for b in lista:
        rr, cc = celulas(b["p"])
        if len(rr) == 0:
            fica.append(b); continue
        ocupado[rr, cc] = True
        if b.get("t") in ("subsolo", "cobertura") or not lidar_ok[rr, cc].mean() > .9:
            if not lidar_ok[rr, cc].mean() > .9: stats["sem_lidar"] += 1
            fica.append(b); continue
        v = ndsm[rr, cc]; v = v[np.isfinite(v) & (v > 1.5)]
        cob = len(v) / len(rr)
        if cob < .05 and len(rr) >= 30:
            stats["demolidos"] += 1; continue            # nada construído ali em 2020
        if cob >= .25 and len(v) >= 4:
            h = float(np.percentile(v, 55))
            if h_min and h < h_min * .6:
                pass                                       # anel: medição estranha, mantém o OSM
            else:
                b["h"] = round(h, 1); b.pop("est", None); b["l"] = 1; stats["medidos"] += 1
            ct = cor_telhado(rr, cc)
            if ct: b["c"] = ct
        fica.append(b)
    return fica

B["predios"] = medir(B["predios"])
B["anel"]["predios"] = medir(B["anel"]["predios"], 12)

# ---------- prédios novos ----------
m = np.isfinite(ndsm) & (ndsm > 2.5)
m &= ~ndi.binary_dilation(ocupado, iterations=2)
m = ndi.binary_opening(m, iterations=1)
lab, n = ndi.label(m, structure=np.ones((3, 3)))
objs = ndi.find_objects(lab)

def contorno(mask):
    cs = find_contours(np.pad(mask, 1).astype(float), .5)
    if not cs: return None
    c = max(cs, key=len)
    pol = Polygon([(x - 1, y - 1) for y, x in c]).buffer(0)
    pol = pol.simplify(1.4 if pol.area > 300 else .8).buffer(0)   # torres: faces retas
    if pol.geom_type != "Polygon" or pol.area < 20: return None
    return pol

def pecas(sub, v_all):
    """Uma mancha vira [(máscara, altura)]: se tem torre sobre embasamento/garagem, a torre sai separada
    (senão a mediana mistura as duas alturas e a torre fica baixa)."""
    v = v_all[sub]; h = float(np.percentile(v, 55)); p95 = float(np.percentile(v, 95))
    if p95 >= 15:
        torre = sub & (v_all >= .72 * p95)
        torre = ndi.binary_opening(torre, iterations=1)
        resto = sub & ~torre
        if torre.sum() >= 50 and resto.sum() >= 50 and float(np.percentile(v_all[torre], 55)) > 1.5 * float(np.percentile(v_all[resto], 55)):
            out = [(resto | torre, float(np.percentile(v_all[resto], 55)))]   # embasamento (a torre cobre o miolo)
            lt, nt = ndi.label(torre)
            for k in range(1, nt + 1):
                t = lt == k
                if t.sum() >= 40: out.append((t, float(np.percentile(v_all[t], 55))))
            return out
    return [(sub, h)]

def novo_predio(sub, h, sl):
    area = int(sub.sum())
    pol = contorno(sub)
    if pol is None: return
    y0, x0 = sl[0].start, sl[1].start
    pts = [(x0 + x - R + .5, y0 + y - R + .5) for x, y in pol.exterior.coords[:-1]]
    cx, cy = np.mean([p[0] for p in pts]), np.mean([p[1] for p in pts])
    d = math.hypot(cx, cy)
    # mesma orientação do gerar_bairro.py (horária em x/norte)
    a2 = sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))
    if a2 < 0: pts = pts[::-1]
    o = {"h": round(h, 1), "p": [round(c, 1) for p in pts for c in p], "l": 1, "novo": 1}
    rr, cc = np.nonzero(sub); ct = cor_telhado(rr + sl[0].start, cc + sl[1].start)
    if ct: o["c"] = ct
    if d <= RAIO:
        B["predios"].append(o); stats["novos"] += 1
    elif d <= ANEL and h >= 12 and area >= 80:
        B["anel"]["predios"].append(o); stats["novos_anel"] += 1

for idx, sl in enumerate(objs, 1):
    if sl is None: continue
    sub0 = lab[sl] == idx
    if int(sub0.sum()) < 30: continue
    for sub, h in pecas(sub0, np.where(sub0, ndsm[sl], np.nan)):
        novo_predio(sub, h, sl)

B["meta"]["fontes"] = ("LiDAR 2020 da PMSP/GeoSampa (alturas medidas e prédios que faltavam no OSM), OpenStreetMap "
                       "(contornos, nomes, ruas, áreas), Overture Maps (construções extras), GeoSampa (árvores)")
B["meta"]["lidar"] = 2020
json.dump(B, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print(stats, "| prédios", len(B["predios"]), "| anel", len(B["anel"]["predios"]))
