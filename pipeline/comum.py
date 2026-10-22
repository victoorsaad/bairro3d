# Configuração e utilitários comuns do pipeline.
# O centro, os raios e o nome do lugar vêm do config.json na raiz do repositório (ou do caminho em BAIRRO3D_CONFIG).
# Sistema de coordenadas de todos os arquivos gerados: metros locais, x = leste, y = norte, origem no centro.
import json, math, os, time, urllib.request, urllib.parse

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = json.load(open(os.environ.get("BAIRRO3D_CONFIG") or os.path.join(RAIZ, "config.json"), encoding="utf-8"))
LAT0, LON0 = float(CFG["lat"]), float(CFG["lon"])
RAIO, ANEL = int(CFG["raio_m"]), int(CFG["anel_m"])
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574
UA = "bairro3d-publico/1.0 (maquete 3D com dados abertos)"


def xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def ll(x, y):
    """(lat, lon) de um ponto em metros locais."""
    return LAT0 + y / KY, LON0 + x / KX


def bbox_wfs(r):
    dlat, dlon = r / KY, r / KX
    return f"{LAT0-dlat},{LON0-dlon},{LAT0+dlat},{LON0+dlon},urn:ogc:def:crs:EPSG::4326"


def abre(url, dados=None, t=300, tentativas=5, espera=15):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, data=dados, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=t).read()
        except Exception as e:
            if i == tentativas - 1:
                raise
            print("tentando de novo:", e, flush=True)
            time.sleep(espera * (i + 1))


def wfs(camada, r, count=2000, ordena=None, cache=None):
    """Todas as feições de uma camada do GeoSampa num quadrado de meia largura r em volta do centro (paginado)."""
    if cache and os.path.exists(cache):
        return json.load(open(cache))["features"]
    fs, i = [], 0
    while True:
        u = ("https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature"
             f"&typeNames=geoportal:{camada}&srsName=EPSG:4326&outputFormat=application/json&count={count}"
             + (f"&sortBy={ordena}" if ordena else "") + (f"&startIndex={i}" if i else "") + f"&bbox={bbox_wfs(r)}")
        lote = json.loads(abre(u)).get("features", [])
        fs += lote
        print(camada, len(fs), flush=True)
        if len(lote) < count:
            break
        i += count
    if cache:
        json.dump({"type": "FeatureCollection", "features": fs}, open(cache, "w"))
    return fs


def overpass(q, cache):
    if os.path.exists(cache):
        return json.load(open(cache))
    d = json.loads(abre("https://overpass-api.de/api/interpreter", ("data=" + urllib.parse.quote(q)).encode(), t=400, espera=30))
    json.dump(d, open(cache, "w"))
    print(os.path.basename(cache), len(d.get("elements", [])), flush=True)
    time.sleep(5)   # educação com o Overpass público
    return d
