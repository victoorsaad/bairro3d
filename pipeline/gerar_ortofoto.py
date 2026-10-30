# Foto aérea do chão: Ortofoto 2020 RGB da Prefeitura (GeoSampa, 10 cm/px), pelo WMS raster.geosampa.
# O quadrado de ±relevo_m é cortado em BLOCOS×BLOCOS imagens de LADO px, pedidas em EPSG:4326: como x/y locais são
# lineares em lon/lat (ver comum.xy), cada imagem cai exata no terreno sem reprojeção.
# Os 4 blocos do meio (onde ficam as casas) saem com LADO px; os de fora, com metade.
# Saída: orto/<coluna>_<linha>.webp (coluna oeste→leste, linha sul→norte) + orto.json (meta). Precisa do Pillow.
# Uso: python -I gerar_ortofoto.py <pasta saída>
import io, json, os, sys, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import CFG, ll, abre

OUT = sys.argv[1]
MEIO, BLOCOS, LADO = int(CFG.get("relevo_m", 2600)), 4, 2048
WMS = "https://raster.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/wms"
CAMADA = "ORTO_RGB_2020"
from PIL import Image              # WebP: o JPEG do servidor vem com ~1 MB por bloco de 2048 px

os.makedirs(f"{OUT}/orto", exist_ok=True)
passo = 2 * MEIO / BLOCOS
total = 0
for j in range(BLOCOS):
    for i in range(BLOCOS):
        x0, y0 = -MEIO + i * passo, -MEIO + j * passo
        px = LADO if 0 < i < BLOCOS - 1 and 0 < j < BLOCOS - 1 else LADO // 2
        (lat0, lon0), (lat1, lon1) = ll(x0, y0), ll(x0 + passo, y0 + passo)
        q = urllib.parse.urlencode({"service": "WMS", "version": "1.1.1", "request": "GetMap", "layers": CAMADA, "styles": "",
                                    "srs": "EPSG:4326", "bbox": f"{lon0},{lat0},{lon1},{lat1}",
                                    "width": px, "height": px, "format": "image/jpeg"})
        dados = abre(f"{WMS}?{q}")
        if not dados.startswith(b"\xff\xd8"):
            sys.exit(f"bloco {i},{j}: o WMS não devolveu JPEG: {dados[:200]!r}")
        arq = f"{OUT}/orto/{i}_{j}.webp"
        Image.open(io.BytesIO(dados)).save(arq, quality=70, method=6)
        total += os.path.getsize(arq)
        print(f"bloco {i},{j}: {px} px, {os.path.getsize(arq) // 1024} KB")

json.dump({"blocos": BLOCOS, "lado_px": LADO, "min": -MEIO, "passo_m": passo, "m_por_px": round(passo / LADO, 3), "m_por_px_fora": round(2 * passo / LADO, 3),
           "fonte": "Ortofoto 2020 RGB — Prefeitura de São Paulo (GeoSampa)", "voo": "jun–ago/2020"},
          open(f"{OUT}/orto.json", "w"), ensure_ascii=False)
print(f"{BLOCOS * BLOCOS} blocos, {total / 1e6:.1f} MB, {passo / LADO:.2f} m/px no meio")
