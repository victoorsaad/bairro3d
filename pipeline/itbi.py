# Preço das vendas registradas (guias de ITBI pagas, Prefeitura de SP) no raio do anel → itbi.json AGREGADO por quadra fiscal.
# Versão pública: nada de transação individual, endereço, complemento ou data exata. Para cada quadra:
#   contorno (união dos lotes do GeoSampa), número de vendas, mediana do R$/m² de apartamentos e de casas
#   (últimos 24 meses e por ano). Quadras com menos de itbi_min_vendas vendas no período ficam de fora.
# Também sai a série do bairro: mediana do R$/m² de apartamentos por semestre, no raio e no anel.
# 1. lotes do GeoSampa (WFS lote_cidadao) no quadrado do anel: SQL → quadra e contorno;
# 2. planilhas anuais de ITBI (.xlsx): só "Compra e venda", parte transmitida integral, sem garagem/terreno.
# Uso: python3 -I itbi.py <bairro.json> <saida itbi.json> <planilhas .xlsx...>
# Requer: openpyxl, shapely
import sys, os, json, math, re, datetime, statistics, itertools
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import openpyxl
from shapely.geometry import shape
from shapely.ops import unary_union, transform
from comum import CFG, wfs

BJ, OUT, XLS = sys.argv[1], sys.argv[2], sys.argv[3:]
B = json.load(open(BJ)); o, k = B["meta"]["origem"], B["meta"]["m_por_grau"]
RAIO, ANEL = B["meta"]["raio_m"], B["meta"].get("anel_m", B["meta"]["raio_m"])
MIN = int(CFG.get("itbi_min_vendas", 5))
norm = lambda s: re.sub(r"\s+", " ", str(s or "").upper().strip())
loc = lambda g: transform(lambda x, y, z=None: ((x - o["lon"]) * k["lon"], (y - o["lat"]) * k["lat"]), g)

# ---------- quadras: união dos lotes ----------
lotes = {}
for f in wfs("lote_cidadao", ANEL):
    p = f["properties"]
    if not f.get("geometry") or not p.get("cd_setor_fiscal") or not p.get("cd_quadra_fiscal"): continue
    try: g = loc(shape(f["geometry"])).buffer(0)
    except Exception: continue
    if g.is_empty: continue
    lotes.setdefault(p["cd_setor_fiscal"] + p["cd_quadra_fiscal"], []).append(g)
quadras = {}
for q, gs in lotes.items():
    u = unary_union(gs).buffer(1.5).buffer(-1.5)
    if u.geom_type == "MultiPolygon": u = max(u.geoms, key=lambda g: g.area)
    if u.geom_type != "Polygon" or u.area < 200: continue
    c = u.representative_point()
    if math.hypot(c.x, c.y) > ANEL: continue
    quadras[q] = u.simplify(2)
print("quadras", len(quadras), flush=True)

# ---------- vendas ----------
hoje = datetime.date.today()
lim24 = (hoje - datetime.timedelta(days=730)).isoformat()
vendas, cab0, n_lidas = {}, None, 0
for arq in XLS:
    wb = openpyxl.load_workbook(arq, read_only=True)
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True); cab = next(it, None)
        if not cab or cab[0] is None: continue
        if "SQL" in str(cab[0]): cab0 = cab
        elif isinstance(cab[0], (int, float)) and cab0:   # aba sem cabeçalho: mesmas colunas da anterior
            it = itertools.chain([cab], it); cab = cab0
        else: continue
        col = {norm(c): j for j, c in enumerate(cab) if c}
        J = lambda nome: next(j for c, j in col.items() if c.startswith(nome))
        jnat, jv, jd, ja, jdu, jp = J("NATUREZA"), J("VALOR DE TRANSAÇÃO"), J("DATA DE TRANSAÇÃO"), J("ÁREA CONSTRUÍDA"), J("DESCRIÇÃO DO USO"), J("PROPORÇÃO TRANSMITIDA")
        for r in it:
            n_lidas += 1
            try: sql = str(int(r[0])).zfill(11)
            except (TypeError, ValueError): continue
            q = sql[:6]
            if q not in quadras or not str(r[jnat] or "").startswith("1."): continue
            v, area = r[jv] or 0, r[ja] or 0
            if v < 20000 or not area or area < 15: continue
            try:
                if float(r[jp]) < 99.9: continue
            except (TypeError, ValueError): pass
            uso = norm(r[jdu])
            if "GARAGEM" in uso or "TERRENO" in uso: continue
            dt = r[jd]; dt = dt.strftime("%Y-%m-%d") if isinstance(dt, (datetime.date, datetime.datetime)) else str(dt)[:10]
            if not re.match(r"\d{4}-\d\d-\d\d$", dt): continue
            u = "ap" if "APARTAMENTO" in uso else "casa" if "RESID" in uso else "outro"
            # a mesma venda aparece em mais de uma planilha: chave sem sair daqui
            vendas[(sql, dt, round(v))] = (q, dt, u, v / area)
    print(arq, "linhas", n_lidas, "vendas", len(vendas), flush=True)

med = lambda xs: round(statistics.median(xs)) if xs else None
por_q = {}
for q, dt, u, m2 in vendas.values():
    por_q.setdefault(q, []).append((dt, u, m2))
saida = []
for q, vs in por_q.items():
    rec = [v for v in vs if v[0] >= lim24]
    if len(rec) < MIN: continue
    g = quadras[q]; c = g.representative_point()
    item = {"p": [round(c_, 1) for xy in list(g.exterior.coords)[:-1] for c_ in xy], "x": round(c.x), "y": round(c.y), "n": len(rec)}
    for u in ("ap", "casa"):
        xs = [m for _, uu, m in rec if uu == u]
        if len(xs) >= MIN: item[u] = {"n": len(xs), "m2": med(xs)}
    anos = {}
    for dt, u, m in vs:
        if u == "ap": anos.setdefault(dt[:4], []).append(m)
    item["anos"] = {a: [med(xs), len(xs)] for a, xs in sorted(anos.items()) if len(xs) >= MIN}
    saida.append(item)

def serie(r):
    sem = {}
    for q, vs in por_q.items():
        if q not in quadras: continue
        c = quadras[q].representative_point()
        if math.hypot(c.x, c.y) > r: continue
        for dt, u, m in vs:
            if u == "ap": sem.setdefault(f"{dt[:4]}-{1 if int(dt[5:7]) <= 6 else 2}", []).append(m)
    return [[s, med(xs), len(xs)] for s, xs in sorted(sem.items()) if len(xs) >= 20]

datas = sorted(v[1] for v in vendas.values())
out = {"raio": ANEL, "minimo": MIN, "gerado": hoje.isoformat(), "periodo": [datas[0][:7], datas[-1][:7]] if datas else None,
       "fonte": "Guias de ITBI pagas, Prefeitura de São Paulo (valor declarado na compra e venda), agregadas por quadra fiscal",
       "quadras": saida, "serie": {"raio": serie(RAIO), "anel": serie(ANEL)}}
json.dump(out, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print("quadras publicadas", len(saida), "de", len(por_q), "| vendas", len(vendas), "| período", out["periodo"])
