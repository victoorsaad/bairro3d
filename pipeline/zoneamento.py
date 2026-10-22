# Zoneamento (Lei 18.177/24) + lotes que podem virar prédio + alvarás de HIS/HMP → zonas.json para a maquete.
# - zonas: polígonos de zona no raio (sem praças/canteiros), em x/norte, simplificados;
# - potenciais: lotes grandes e ainda baixos (LiDAR 2020 < 12 m) em zona que permite prédio alto, com a altura
#   estimada pelo coeficiente máximo (CA) e o gabarito da zona;
# - alvaras: alvarás de aprovação/execução de HIS/HMP (WFS habitacao_popular), no lote, com altura estimada.
# - obras: pedidos de alvará de edificação nova, reforma e demolição do Aprova Digital (dados abertos SMUL, 2020→),
#   casados com o lote pelo SQL; "concluída" quando o lote tem Certificado de Conclusão depois do alvará.
# Uso: python3 -I zoneamento.py <bairro.json> <saida zonas.json> [extratos do Aprova Digital .csv/.xlsx ...]
# Requer: shapely (e openpyxl para os extratos .xlsx)
import sys, json, math, time, urllib.request
from shapely.geometry import shape, Polygon, Point
from shapely.ops import transform
from shapely.strtree import STRtree
from shapely import affinity

BJ, OUT, AD = sys.argv[1], sys.argv[2], sys.argv[3:]
B = json.load(open(BJ)); o, k, RAIO = B["meta"]["origem"], B["meta"]["m_por_grau"], B["meta"]["raio_m"]
RAIO = B["meta"].get("anel_m", RAIO)   # desde 09/10/2026 as camadas cobrem o anel inteiro (2,3 km), como os chunks
dlat, dlon = (RAIO + 100) / k["lat"], (RAIO + 100) / k["lon"]
BB = f"{o['lat']-dlat},{o['lon']-dlon},{o['lat']+dlat},{o['lon']+dlon},urn:ogc:def:crs:EPSG::4326"
H = {"User-Agent": "bairro3d-publico/1.0 (maquete 3D com dados abertos)"}
# CA máximo e gabarito (m) — Quadro 3 da Lei 16.402/16 (revisada pela 18.081/24); None = sem limite de altura
PARAM = {"ZEU": (4, None), "ZEUP": (2, 28), "ZEIS-1": (2.5, None), "ZEIS-2": (4, None), "ZEIS-3": (4, None), "ZEIS-5": (4, None),
         "ZC": (2, 48), "ZM": (2, 28), "ZCOR-2": (1, 15), "ZER-1": (1, 10)}
AREA_MIN = {"ZEU": 500, "ZEIS-2": 500, "ZEIS-3": 500, "ZEIS-5": 500, "ZEIS-1": 800, "ZC": 1000, "ZM": 1500}

def wfs(camada, extra=""):
    fs, i = [], 0
    while True:
        u = (f"https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature"
             f"&typeNames=geoportal:{camada}&srsName=EPSG:4326&outputFormat=application/json&count=2000&startIndex={i}&bbox={BB}{extra}")
        for t in range(4):
            try: d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=180)); break
            except Exception:
                if t == 3: raise
                time.sleep(5)
        lote = d.get("features", []); fs += lote
        if len(lote) < 2000: return fs
        i += 2000

loc = lambda g: transform(lambda x, y, z=None: ((x - o["lon"]) * k["lon"], (y - o["lat"]) * k["lat"]), g)
plano = lambda p: [round(c, 1) for xy in list(p.exterior.coords)[:-1] for c in xy]
circ = Point(0, 0).buffer(RAIO)

# zonas
zonas = []
for f in wfs("perimetro_zona_lei_18177_24"):
    z = f["properties"]["cd_zoneamento_perimetro"]
    if not f["geometry"] or z in ("Praça/Canteiro", None): continue
    g = loc(shape(f["geometry"])).intersection(circ).simplify(1.5)
    for p in getattr(g, "geoms", [g]):
        if p.geom_type == "Polygon" and p.area > 50: zonas.append((z, p))
print("zonas", len(zonas))
arv_z = STRtree([p for _, p in zonas])
zona_em = lambda pt: next((zonas[j][0] for j in arv_z.query(pt) if zonas[j][1].contains(pt)), None)

# prédios do bairro.json (altura atual, LiDAR 2020)
pols, hs = [], []
# o anel do bairro.json só tem as torres; casas e prédios baixos do anel vêm dos chunks (pasta chunks/ ao lado)
import os, glob
CH = [c for arq in glob.glob(os.path.join(os.path.dirname(os.path.abspath(BJ)), "chunks", "c_*.json")) for c in json.load(open(arq))["predios"]]
for b in B["predios"] + B["anel"]["predios"] + CH:
    p = b["p"]
    try: pg = Polygon(list(zip(p[0::2], p[1::2])))
    except Exception: continue
    if pg.is_valid and pg.area > 4: pols.append(pg); hs.append(b["h"])
arv_b = STRtree(pols)
def altura_no(lote):
    m = 0
    for j in arv_b.query(lote):
        if pols[j].intersection(lote).area > .4 * pols[j].area: m = max(m, hs[j])
    return m

def estima(z, area_t, area_c=None):
    """Altura plausível (m) de um prédio novo no lote: CA máximo (ou a área aprovada) sobre uma projeção típica."""
    ca, gab = PARAM.get(z, (2, 28))
    total = area_c or ca * area_t
    proj = min(.5 * area_t, 650)                 # torre ocupa até metade do lote, no máximo ~650 m²
    h = 4 + (total / proj) * 3
    return round(min(h, gab) if gab else min(h, 140), 1), round(proj)

# lotes
lotes, por_sql = [], {}
for f in wfs("lote_cidadao"):
    pr = f["properties"]
    if not f["geometry"] or pr.get("cd_tipo_lote") != "F": continue
    g = loc(shape(f["geometry"]))
    if g.geom_type != "Polygon" or not circ.contains(g.centroid): continue
    sql = (pr["cd_setor_fiscal"] or "") + (pr["cd_quadra_fiscal"] or "") + (pr["cd_lote"] or "")
    por_sql[sql] = g; lotes.append((pr, g))
print("lotes", len(lotes))

# lotes de condomínio aparecem repetidos (um por unidade): junta pelo polígono
vistos, potenciais = set(), []
for pr, g in lotes:
    chave = (round(g.centroid.x), round(g.centroid.y))
    if chave in vistos: continue
    vistos.add(chave)
    z = zona_em(g.representative_point())
    if z not in AREA_MIN or g.area < AREA_MIN[z]: continue
    h0 = altura_no(g)
    if h0 >= 12: continue
    uso = (pr.get("dc_tipo_uso_imovel") or "").lower()
    if any(w in uso for w in ("escola", "templo", "hospital")): continue
    hp, proj = estima(z, g.area)
    if hp < max(18, h0 + 9): continue
    end = " ".join(str(x) for x in (pr.get("nm_logradouro_completo"), pr.get("cd_numero_porta")) if x)
    potenciais.append({"z": z, "p": plano(g.simplify(.8)), "a": round(g.area), "h0": round(h0, 1), "h": hp, "proj": proj,
                       "e": end.title(), "uso": pr.get("dc_tipo_uso_imovel")})
print("potenciais", len(potenciais))

# alvarás de HIS/HMP
alvaras = []
for f in wfs("habitacao_popular"):
    pr = f["properties"]; sql = (pr.get("cd_sql_incra") or "")[:10]
    g = por_sql.get(sql)
    if g is None and f.get("geometry"):
        g = loc(shape(f["geometry"]))
        if g.geom_type != "Polygon": g = g.buffer(8)
    if g is None or not circ.contains(g.centroid): continue
    z = zona_em(g.representative_point()) or "?"
    at, ac = pr.get("qt_area_total_terreno") or g.area, pr.get("qt_area_construida_total") or 0
    hp, proj = estima(z, at, ac)
    h0 = altura_no(g)
    alvaras.append({"p": plano(g.simplify(.8)), "e": pr.get("tx_grupo_endereco"), "z": z, "ac": round(ac), "a": round(at),
                    "u": (pr.get("qt_unidade_his") or 0) + (pr.get("qt_unidade_hmp") or 0), "h": hp, "h0": round(h0, 1),
                    "def": (pr.get("dt_deferimento_execucao") or "")[:10] or None, "aut": (pr.get("dt_autuacao_execucao") or "")[:10] or None,
                    "doc": pr.get("cd_numero_documento_execucao"), "t": pr.get("tx_assunto_alvara")})
print("alvaras", len(alvaras))

# lote que já tem alvará não aparece de novo como "pode virar prédio"
pa = [Polygon(list(zip(a["p"][0::2], a["p"][1::2]))).buffer(2) for a in alvaras]
potenciais = [q for q in potenciais if not any(x.contains(Polygon(list(zip(q["p"][0::2], q["p"][1::2]))).centroid) for x in pa)]
print("potenciais sem alvará", len(potenciais))

# ---------- obras (Aprova Digital) ----------
import csv, io, re, unicodedata, datetime
sem_acento = lambda t: unicodedata.normalize("NFKD", str(t or "")).encode("ascii", "ignore").decode().lower().strip(" ;'")
def ler_ad(arq):
    if arq.endswith(".xlsx"):
        import openpyxl
        it = openpyxl.load_workbook(arq, read_only=True).worksheets[0].iter_rows(values_only=True); cab = [sem_acento(c) for c in next(it)]
        linhas = it
    else:
        raw = open(arq, "rb").read()
        try: t = raw.decode("utf-8-sig")
        except UnicodeDecodeError: t = raw.decode("latin1")
        rd = csv.reader(io.StringIO(t), delimiter=";"); cab = [sem_acento(c) for c in next(rd)]; linhas = rd
    if cab.count("protocolo") > 1:     # cabeçalho com um pedaço repetido (1º sem./2025): vale o último
        i = len(cab) - 1 - cab[::-1].index("protocolo"); cab = ["processo"] + cab[i:]
    J = lambda *ns: next((j for n in ns for j, c in enumerate(cab) if c.startswith(n)), None)
    js, jd, ja, je, jt, jc, jp, ju, jpr = J("sql"), J("data_autu"), J("assunto"), J("endere"), J("area_terreno"), J("area_construir"), J("pavimentos"), J("unidades_res"), J("processo")
    if "distrito" in cab and cab.index("area_existente") < cab.index("area_construir"):
        # 2º sem./2025: os valores estão deslocados em relação ao cabeçalho (conferido com processos conhecidos)
        jc, jp, ju = J("area_existente"), J("blocos"), J("pavimentos")
    num = lambda v: float(str(v).replace(".", "").replace(",", ".")) if re.fullmatch(r"[\d.]+,\d+|\d+", str(v or "").strip()) else (float(v) if isinstance(v, (int, float)) else (float(v) if re.fullmatch(r"\d+\.\d+", str(v or "").strip()) else 0))
    for r in linhas:
        r = list(r) + [None] * (len(cab) - len(r))
        sql = re.sub(r"\D", "", str(r[js] or ""))[:10]
        if len(sql) < 10: continue
        d = r[jd]
        if isinstance(d, (datetime.date, datetime.datetime)): d = d.strftime("%Y-%m-%d")
        else:
            d = str(d or "")[:10]; m = re.match(r"(\d\d)/(\d\d)/(\d{4})", d); d = f"{m[3]}-{m[2]}-{m[1]}" if m else d
        yield {"sql": sql, "d": d, "a": str(r[ja] or ""), "e": str(r[je] or "") if je is not None else "", "at": num(r[jt]), "ac": num(r[jc]),
               "pav": int(num(r[jp])) if jp is not None else 0, "u": int(num(r[ju])) if ju is not None else 0, "proc": r[jpr]}
por_lote = {}
for arq in AD:
    for r in ler_ad(arq):
        if r["sql"] in por_sql: por_lote.setdefault(r["sql"], []).append(r)
obras = []
ja_his = {a["doc"] for a in alvaras}
for sql, rs in por_lote.items():
    rs.sort(key=lambda r: r["d"])
    novas = [r for r in rs if "edificacao nova" in sem_acento(r["a"]) and "modificativo" not in sem_acento(r["a"])]
    ref = [r for r in rs if "reforma" in sem_acento(r["a"])]
    dem = [r for r in rs if "demolicao" in sem_acento(r["a"])]
    if not (novas or ref or dem): continue
    r = (novas or ref or dem)[-1]
    tipo = "nova" if novas else "reforma" if ref else "demolicao"
    if tipo == "nova" and r["ac"] < 250 and r["pav"] < 3: continue      # casas pequenas: poluiria o mapa
    concl = next((x["d"] for x in rs if "conclus" in sem_acento(x["a"]) and x["d"] >= r["d"]), None)
    g = por_sql[sql]; z = zona_em(g.representative_point()) or "?"
    his = "his" in sem_acento(r["a"]).replace("exceto his", "")
    if r["pav"]: h = 4 + r["pav"] * 3
    else: h = estima(z, r["at"] or g.area, r["ac"] or None)[0]
    # endereço só para obra nova de porte; reforma e demolição (muitas vezes casas) saem sem endereço
    obras.append({"p": plano(g.simplify(.8)), "e": (r["e"].split(",  ")[0][:90] or None) if tipo == "nova" else None, "z": z, "tipo": tipo, "his": his, "d": r["d"], "concl": concl,
                  "ac": round(r["ac"]), "a": round(r["at"] or g.area), "pav": r["pav"], "u": r["u"], "h": round(h, 1), "h0": round(altura_no(g), 1),
                  "assunto": r["a"], "n": len(rs)})
# mesmo lote nas duas fontes: fica a obra do Aprova Digital (tem andares e unidades) com a data de deferimento do GeoSampa
pol = lambda q: Polygon(list(zip(q["p"][0::2], q["p"][1::2])))
fora = set()
for ob in obras:
    if ob["tipo"] != "nova": continue
    for i, a in enumerate(alvaras):
        if i not in fora and pol(a).buffer(1).contains(pol(ob).centroid):
            ob["def"] = a["def"]; ob["his"] = True; fora.add(i)   # está na camada de HIS/HMP
alvaras = [a for i, a in enumerate(alvaras) if i not in fora]
print("alvarás HIS fundidos com obras", len(fora))
po = [Polygon(list(zip(ob["p"][0::2], ob["p"][1::2]))).buffer(1) for ob in obras if ob["tipo"] == "nova"]
potenciais = [q for q in potenciais if not any(x.contains(Polygon(list(zip(q["p"][0::2], q["p"][1::2]))).centroid) for x in po)]
import collections
print("potenciais sem obra", len(potenciais))
print("obras", len(obras), collections.Counter((o_["tipo"], o_["his"], bool(o_["concl"])) for o_ in obras))

json.dump({"raio": RAIO, "fonte": "GeoSampa: Perímetro de Zonas (Lei 18.177/24), lotes fiscais, HIS e HMP – Alvará de Execução; Aprova Digital (SMUL, dados abertos); alturas atuais da maquete (OSM; LiDAR 2020 quando disponível)",
           "param": {z: {"ca": v[0], "gab": v[1]} for z, v in PARAM.items()},
           "zonas": [{"z": z, "p": plano(p)} for z, p in zonas], "potenciais": potenciais, "alvaras": alvaras, "obras": obras},
          open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
