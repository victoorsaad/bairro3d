# Grade de relevo (altitude do terreno) a partir das curvas de nível e pontos cotados do GeoSampa (levantamento 2004, 1:1000).
# Saída: relevo.bin (Int16, decímetros acima de `base`) + relevo.json (meta). Mesmo sistema de bairro.json (x leste, y norte).
# Uso: python -I gerar_relevo.py <pasta raw> <pasta saída>
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from scipy.interpolate import griddata
from scipy.ndimage import gaussian_filter

RAW, OUT = sys.argv[1], sys.argv[2]
from comum import CFG, LAT0, LON0, KX, KY
MEIO, PASSO = int(CFG.get("relevo_m", 2600)), 10          # grade de ±2,6 km, um ponto a cada 10 m
xy = lambda lon, lat: ((lon - LON0) * KX, (lat - LAT0) * KY)

pts, z = [], []
for nome in ("curva_mestra", "curva_intermediaria"):
    for f in json.load(open(f"{RAW}/geosampa_{nome}.json"))["features"]:
        alt = f["properties"]["cd_numero_isovalor"]
        g = f["geometry"]
        linhas = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for ln in linhas:
            q = [xy(*c[:2]) for c in ln]
            for (x1, y1), (x2, y2) in zip(q, q[1:]):          # adensa: um ponto a cada ~5 m
                n = max(1, int(math.hypot(x2 - x1, y2 - y1) // 5))
                for k in range(n):
                    pts.append((x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n)); z.append(alt)
for f in json.load(open(f"{RAW}/geosampa_ponto_cotado.json"))["features"]:
    pts.append(xy(*f["geometry"]["coordinates"][:2])); z.append(f["properties"]["cd_altitude"])
pts, z = np.array(pts), np.array(z, dtype=float)
print(f"{len(z)} pontos de altitude, de {z.min():.1f} a {z.max():.1f} m")

eixo = np.arange(-MEIO, MEIO + PASSO, PASSO)
gx, gy = np.meshgrid(eixo, eixo)                     # linha = y (sul→norte), coluna = x (oeste→leste)
grade = griddata(pts, z, (gx, gy), method="linear")
falta = np.isnan(grade)
if falta.any():
    grade[falta] = griddata(pts, z, (gx[falta], gy[falta]), method="nearest")
grade = gaussian_filter(grade, 1.0)                  # tira o degrau das curvas de 1 m

i0 = len(eixo) // 2
base = float(grade[i0, i0])                          # altitude no centro
dec = np.round((grade - base) * 10).astype("<i2")
dec.tofile(f"{OUT}/relevo.bin")
# curvas de nível de 5 em 5 m, tiradas da própria grade (batem com o terreno desenhado)
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
curvas = []
niveis = np.arange(np.ceil(grade.min() / 5) * 5, grade.max(), 5)
cs = plt.contour(gx, gy, grade, levels=niveis)
for nivel, segs in zip(cs.levels, cs.allsegs):
    for seg in segs:
        if len(seg) < 3:
            continue
        pts = seg[::2] if len(seg) > 6 else seg          # a grade é de 10 m: um ponto a cada ~20 m basta
        curvas.append({"z": int(nivel), "p": [round(float(v), 1) for q in pts for v in q]})
json.dump({"passo": PASSO, "n": len(eixo), "min": -MEIO, "base_altitude": round(base, 2),
           "unidade": "decímetros acima de base_altitude; linha = y (sul→norte), coluna = x (oeste→leste)",
           "fonte": "GeoSampa — curvas de nível e pontos cotados (PMSP, 2004)", "curvas": curvas}, open(f"{OUT}/relevo.json", "w"), ensure_ascii=False)
print(f"{len(curvas)} curvas | grade {len(eixo)}×{len(eixo)} | base (centro) {base:.1f} m | relativo de {dec.min()/10:.1f} a {dec.max()/10:.1f} m")
