# Camadas extras da maquete → camadas.json: alagamento, transporte e (opcional) crimes.
# - alagamento: manchas de inundação do GeoSampa (chuva de 25 e 100 anos, com profundidade) + áreas de risco hidrológico;
# - transporte: pontos de ônibus (com as linhas que passam a ≤25 m), faixas exclusivas, metrô e trem (em operação e
#   projetados, num raio de 3 km);
# - crimes: planilhas anuais "SPDadosCriminais_AAAA.xlsx" da SSP-SP (boletins com latitude/longitude), últimos 12 meses,
#   publicados SÓ como contagem numa grade (célula de crime_celula_m, padrão 100 m) por tipo e período do dia; células com
#   menos de crime_min ocorrências somem. Nenhum boletim, data ou ponto individual sai daqui.
# Uso: python3 -I camadas.py <bairro.json> <saida camadas.json> [SPDadosCriminais_*.xlsx ...]
# Requer: shapely (e openpyxl para os crimes)
import sys, os, json, math, time, datetime, re, urllib.request, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import CFG
from shapely.geometry import shape, Point
from shapely.ops import transform, unary_union

BJ, OUT, XLS = sys.argv[1], sys.argv[2], sys.argv[3:]
B = json.load(open(BJ)); o, k, RAIO = B["meta"]["origem"], B["meta"]["m_por_grau"], B["meta"]["raio_m"]
RAIO = B["meta"].get("anel_m", RAIO)   # desde 09/10/2026 as camadas cobrem o anel inteiro (2,3 km), como os chunks
H = {"User-Agent": "bairro3d-publico/1.0 (maquete 3D com dados abertos)"}
def bbox(r):
    dlat, dlon = r / k["lat"], r / k["lon"]
    return f"{o['lat']-dlat},{o['lon']-dlon},{o['lat']+dlat},{o['lon']+dlon},urn:ogc:def:crs:EPSG::4326"
def wfs(camada, r):
    fs, i = [], 0
    while True:
        pag = f"&startIndex={i}" if i else ""     # algumas camadas recusam startIndex sem ordenação
        u = (f"https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature"
             f"&typeNames=geoportal:{camada}&srsName=EPSG:4326&outputFormat=application/json&count=2000{pag}&bbox={bbox(r)}")
        for t in range(4):
            try: d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=180)); break
            except Exception:
                if t == 3: raise
                time.sleep(5)
        lote = d.get("features", []); fs += lote
        if len(lote) < 2000: return fs
        i += 2000
loc = lambda g: transform(lambda x, y, z=None: ((x - o["lon"]) * k["lon"], (y - o["lat"]) * k["lat"]), g)
xy = lambda lat, lon: (round((lon - o["lon"]) * k["lon"], 1), round((lat - o["lat"]) * k["lat"], 1))
plano = lambda p: [round(c, 1) for xy_ in list(p.exterior.coords)[:-1] for c in xy_]
linha = lambda l: [round(c, 1) for xy_ in l.coords for c in xy_[:2]]
circ = Point(0, 0).buffer(RAIO)
out = {"raio": RAIO, "fonte": {}, "gerado": datetime.date.today().isoformat()}

# ---------- alagamento ----------
alag = []
for tr in (100, 25):        # 100 anos primeiro (mais clara, por baixo), 25 por cima
    fs = wfs(f"mancha_inundacao_{tr}", RAIO + 50)
    # junta por faixa de profundidade: até 30 cm, 30–80 cm, mais de 80 cm
    faixas = {0: [], 1: [], 2: []}
    for f in fs:
        if not f["geometry"]: continue
        p = f["properties"].get("qt_profundidade_maxima") or 0
        faixas[0 if p < .3 else 1 if p < .8 else 2].append(loc(shape(f["geometry"])).buffer(.6))
    for fx, gs in faixas.items():
        if not gs: continue
        g = unary_union(gs).intersection(circ).simplify(1.2)
        for p in getattr(g, "geoms", [g]):
            if p.geom_type == "Polygon" and p.area > 25: alag.append({"tr": tr, "f": fx, "p": plano(p)})
    print("mancha", tr, len(fs))
risco = []
for f in wfs("risco_hidrologico", RAIO + 50):
    pr = f["properties"]; g = loc(shape(f["geometry"]))
    for p in getattr(g, "geoms", [g]):
        risco.append({"n": pr.get("nm_area_risco_hidrologico"), "grau": pr.get("tx_grau_risco_hidrologico"),
                      "tipo": (pr.get("tx_tipo_processo") or "").lower(), "vist": (pr.get("dt_vistoria") or "")[:10], "p": plano(p)})
out["alagamento"] = {"manchas": alag, "risco": risco}
out["fonte"]["alagamento"] = "GeoSampa: manchas de inundação (chuva com retorno de 25 e 100 anos) e áreas de risco hidrológico"

# ---------- transporte ----------
linhas = []
for f in wfs("linha_onibus", RAIO + 300):
    pr = f["properties"]; g = loc(shape(f["geometry"]))
    linhas.append((pr.get("cd_linha_geometria"), g, pr))
pontos = []
for f in wfs("ponto_onibus", RAIO):
    pr = f["properties"]; g = loc(shape(f["geometry"]))
    if not circ.contains(g): continue
    ls = sorted({c for c, lg, _ in linhas if c and lg.distance(g) <= 25})
    pontos.append({"x": round(g.x, 1), "y": round(g.y, 1), "n": (pr.get("tx_descricao_ponto_onibus") or pr.get("nm_ponto_onibus") or "").strip().title(), "l": ls})
faixas = []
for f in wfs("faixa_onibus", RAIO + 100):
    pr = f["properties"]; g = loc(shape(f["geometry"])).intersection(circ)
    for l in getattr(g, "geoms", [g]):
        if l.geom_type == "LineString" and l.length > 10:
            faixas.append({"n": pr.get("nm_logradouro_faixa_corredor"), "h": pr.get("tx_horario_funcionamento"), "t": pr.get("nm_tipo_faixa_corredor"), "p": linha(l.simplify(1))})
trilhos = {"estacoes": [], "linhas": []}
COR = {"AZUL": "#0455a1", "VERDE": "#007e5e", "VERMELHA": "#ee372f", "AMARELA": "#fed304", "LILÁS": "#a74a95", "PRATA": "#9b9b9b",
       "OURO": "#c8a55e", "TURQUESA": "#00a8a8", "CORAL": "#f04e23", "SAFIRA": "#133c8d", "JADE": "#00a78e", "ESMERALDA": "#00a78e", "RUBI": "#9e1766", "DIAMANTE": "#97a098", "ROSA": "#e5007e", "LARANJA": "#ff8000", "VIOLETA": "#7b3f98", "MARROM": "#7a4a2a", "CELESTE": "#5bc0eb"}
R3 = 3000
for camada, tipo, proj in (("estacao_metro", "metrô", False), ("estacao_metro_projetada", "metrô", True), ("estacao_trem", "trem", False), ("estacao_trem_projetada", "trem", True)):
    for f in wfs(camada, R3):
        pr = f["properties"]; g = loc(shape(f["geometry"])).centroid
        if math.hypot(g.x, g.y) > R3: continue
        cor = (pr.get("nm_linha_metro_trem") or "").upper()
        trilhos["estacoes"].append({"n": (pr.get("nm_estacao_metro_trem") or "").title(), "x": round(g.x, 1), "y": round(g.y, 1), "tipo": tipo, "proj": proj,
                                    "linha": cor.title(), "cor": COR.get(cor, "#555"), "sit": pr.get("tx_situacao_metro_trem") or ("projetada" if proj else None)})
for camada, proj in (("linha_metro", False), ("linha_metro_projetada", True), ("linha_trem", False), ("linha_trem_projetada", True)):
    for f in wfs(camada, R3):
        pr = f["properties"]; g = loc(shape(f["geometry"])).intersection(Point(0, 0).buffer(R3))
        cor = (pr.get("nm_linha_metro_trem") or "").upper()
        if "EXPRESSO" in (pr.get("nr_nome_linha") or "").upper(): continue      # traçado esquemático (reta de 2 pontos)
        for l in getattr(g, "geoms", [g]):
            if l.geom_type == "LineString" and l.length > 20:
                trilhos["linhas"].append({"n": pr.get("nr_nome_linha") or cor.title(), "cor": COR.get(cor, "#555"), "proj": proj, "p": linha(l.simplify(4))})
out["transporte"] = {"pontos": pontos, "faixas": faixas, **trilhos}
out["fonte"]["transporte"] = "GeoSampa: pontos e linhas de ônibus (SPTrans), faixas exclusivas, estações e linhas de metrô e trem"
print("pontos", len(pontos), "faixas", len(faixas), "estações", len(trilhos["estacoes"]), "trilhos", len(trilhos["linhas"]))

# ---------- crimes (SSP) ----------
if XLS:
    import openpyxl
    norm = lambda s: re.sub(r"\s+", " ", str(s or "").upper().strip())
    lat0, lat1, lon0, lon1 = o["lat"] - RAIO / k["lat"], o["lat"] + RAIO / k["lat"], o["lon"] - RAIO / k["lon"], o["lon"] + RAIO / k["lon"]
    regs, vistos = [], set()
    for arq in XLS:
        wb = openpyxl.load_workbook(arq, read_only=True)
        for ws in wb.worksheets:
            it = ws.iter_rows(values_only=True); cab = next(it, None)
            if not cab: continue
            col = {norm(c): j for j, c in enumerate(cab) if c}
            if "LATITUDE" not in col: continue
            J = lambda *ns: next((col[c] for n in ns for c in col if c.startswith(n)), None)
            jla, jlo, jnat, jd, jh, jbo, jdesc, jano = J("LATITUDE"), J("LONGITUDE"), J("NATUREZA_APURADA", "NATUREZA"), J("DATA_OCORRENCIA"), J("HORA_OCORRENCIA"), J("NUM_BO"), J("DESCR_CONDUTA"), J("ANO_BO")
            jloc = J("DESCR_TIPOLOCAL")
            n = 0
            for r in it:
                try: la, lo = float(str(r[jla]).replace(",", ".")), float(str(r[jlo]).replace(",", "."))
                except (TypeError, ValueError): continue
                if not (lat0 < la < lat1 and lon0 < lo < lon1): continue
                x, y = xy(la, lo)
                if math.hypot(x, y) > RAIO: continue
                d = r[jd]; d = d.strftime("%Y-%m-%d") if isinstance(d, (datetime.date, datetime.datetime)) else str(d or "")[:10]
                ch = (r[jbo], r[jano] if jano is not None else None, norm(r[jnat]))
                if ch in vistos: continue
                vistos.add(ch)
                h = r[jh] if jh is not None else None
                h = h.hour if isinstance(h, (datetime.time, datetime.datetime)) else (int(str(h)[:2]) if h and str(h)[:2].isdigit() else None)
                regs.append({"x": x, "y": y, "d": d, "h": h, "t": norm(r[jnat]).title(), "c": (norm(r[jdesc]).title() or None) if jdesc is not None and norm(r[jdesc]) != "NULL" else None,
                             "lc": norm(r[jloc]).title() if jloc is not None else None})
                n += 1
            print(arq, ws.title, n, flush=True)
    fim = max(r["d"] for r in regs if re.match(r"\d{4}-\d\d-\d\d", r["d"] or ""))
    ini = (datetime.date.fromisoformat(fim) - datetime.timedelta(days=365)).isoformat()
    regs = [r for r in regs if r["d"] and ini < r["d"] <= fim]
    # agregação: célula de CEL m, contagem por categoria e por período do dia (madrugada, manhã, tarde, noite)
    CEL, MIN = int(CFG.get("crime_celula_m", 100)), int(CFG.get("crime_min", 3))
    CATS = [("roubo", lambda t: t.startswith("Roubo")), ("furto", lambda t: t.startswith("Furto - ")),
            ("veiculo", lambda t: re.search(r"Ve[íi]culo", t)), ("agressao", lambda t: re.search(r"Dolos|Homic[íi]dio Doloso|Tentativa De Homic", t)),
            ("transito", lambda t: re.search(r"Tr[âa]nsito", t))]
    cel = {}
    for r in regs:
        k = (math.floor(r["x"] / CEL), math.floor(r["y"] / CEL))
        c = cel.setdefault(k, {"n": 0, "cat": collections.Counter(), "per": [0, 0, 0, 0]})
        c["n"] += 1
        for nome, f in CATS:
            if f(r["t"]): c["cat"][nome] += 1
        if r["h"] is not None and 0 <= r["h"] < 24: c["per"][r["h"] // 6] += 1
    celulas = [{"x": (i + .5) * CEL, "y": (j + .5) * CEL, "n": c["n"], **{nome: c["cat"][nome] for nome, _ in CATS if c["cat"][nome]}, "per": c["per"]}
               for (i, j), c in sorted(cel.items()) if c["n"] >= MIN]
    out["crimes"] = {"ini": ini, "fim": fim, "celula_m": CEL, "minimo": MIN, "total": len(regs),
                     "total_publicado": sum(c["n"] for c in celulas), "cats": [n for n, _ in CATS], "celulas": celulas}
    out["fonte"]["crimes"] = (f"SSP-SP, dados criminais com local (12 meses), agregados em células de {CEL} m; "
                              f"células com menos de {MIN} ocorrências omitidas")
    print("crimes", len(regs), ini, fim, "células", len(celulas), collections.Counter(r["t"] for r in regs).most_common(8))

json.dump(out, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
