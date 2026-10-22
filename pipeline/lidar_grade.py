# Converte as folhas LAZ do MDS 2020 da PMSP (LiDAR, EPSG:31983) numa grade de 1 m nas coordenadas da maquete
# (x = leste, y = norte, metros a partir do centro do config.json). Saída: lidar_grade.npz com
#   bld  = Z máximo dos pontos classe 6 (edificação) em cada célula (NaN sem ponto)
#   chao = Z mínimo dos pontos classe 2 (terreno)
#   rgb  = cor (foto aérea 2020) do ponto de edificação mais alto da célula (0 = sem ponto)
# Uso: python3 -I lidar_grade.py <pasta com .zip/.laz> <saida.npz>
# Requer: laspy[lazrs], numpy, pyproj
import sys, glob, os, zipfile, io, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, laspy
from pyproj import Transformer
from comum import LAT0, LON0, KX, KY, ANEL

PASTA, OUT = sys.argv[1], sys.argv[2]
R = ANEL + 100                # meia largura da grade (m)
N = 2 * R
bld = np.full((N, N), -np.inf, np.float32)
chao = np.full((N, N), np.inf, np.float32)
rgb = np.zeros((N * N, 3), np.uint8)
utm2ll = Transformer.from_crs(31983, 4326, always_xy=True)

def ler(caminho):
    if caminho.endswith(".zip"):
        with zipfile.ZipFile(caminho) as z:
            nome = next(n for n in z.namelist() if n.lower().endswith(".laz"))
            return laspy.read(io.BytesIO(z.read(nome)))
    return laspy.read(caminho)

arqs = sorted(glob.glob(f"{PASTA}/*.zip") + glob.glob(f"{PASTA}/*.laz"))
for k, a in enumerate(arqs):
    try:
        l = ler(a)
    except Exception as e:
        print("falhou", a, e); continue
    c = np.asarray(l.classification)
    sel = (c == 6) | (c == 2)
    X, Y, Z = np.asarray(l.x)[sel], np.asarray(l.y)[sel], np.asarray(l.z, np.float32)[sel]
    cor = np.stack([np.asarray(l.red)[sel], np.asarray(l.green)[sel], np.asarray(l.blue)[sel]], 1); c = c[sel]
    if cor.max() > 255: cor = cor // 256
    lon, lat = utm2ll.transform(X, Y)
    i = np.floor((lat - LAT0) * KY + R).astype(np.int64)        # linha = norte
    j = np.floor((lon - LON0) * KX + R).astype(np.int64)        # coluna = leste
    ok = (i >= 0) & (i < N) & (j >= 0) & (j < N)
    i, j, Z, c, cor = i[ok], j[ok], Z[ok], c[ok], cor[ok]
    idx = i * N + j
    b = c == 6
    np.maximum.at(bld.reshape(-1), idx[b], Z[b])
    np.minimum.at(chao.reshape(-1), idx[~b], Z[~b])
    o = np.argsort(Z[b]); rgb[idx[b][o]] = cor[b][o]   # o mais alto escreve por último
    print(f"{k+1}/{len(arqs)} {os.path.basename(a)} {b.sum()} edif. {(~b).sum()} chão", flush=True)

bld[~np.isfinite(bld)] = np.nan; chao[~np.isfinite(chao)] = np.nan
np.savez_compressed(OUT, bld=bld, chao=chao, rgb=rgb.reshape(N, N, 3), R=R)
print("ok", OUT, np.isfinite(bld).sum(), "células de edificação")
