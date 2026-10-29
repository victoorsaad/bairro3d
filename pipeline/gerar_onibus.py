# Ônibus programados (GTFS da SPTrans) → onibus.json: para cada viagem que passa pelo bairro, o trecho do traçado
# dentro do raio, a hora de passagem em cada parada do trecho (relativa ao início da viagem) e as frequências por faixa
# de horário. O navegador põe os ônibus no traçado conforme a hora de agora: é a grade programada, não posição ao vivo.
# Uso: python3 -I gerar_onibus.py <pasta do GTFS descompactado> <bairro.json> <saida onibus.json>
import csv, json, math, sys, datetime

G, BJ, SAIDA = sys.argv[1:4]
B = json.load(open(BJ)); o, k = B["meta"]["origem"], B["meta"]["m_por_grau"]
R = B["meta"].get("anel_m", 2300) + 300
xy = lambda lat, lon: ((float(lon) - o["lon"]) * k["lon"], (float(lat) - o["lat"]) * k["lat"])
seg = lambda h: (lambda a: int(a[0]) * 3600 + int(a[1]) * 60 + int(a[2]))(h.split(":"))
ler = lambda nome: csv.DictReader(open(f"{G}/{nome}", encoding="utf-8-sig", newline=""))

rotas = {r["route_id"]: r for r in ler("routes.txt") if r["route_type"] == "3"}
viagens = {t["trip_id"]: t for t in ler("trips.txt") if t["route_id"] in rotas}
paradas = {s["stop_id"]: xy(s["stop_lat"], s["stop_lon"]) for s in ler("stops.txt")}
seq = {}
for st in ler("stop_times.txt"):
    if st["trip_id"] in viagens:
        seq.setdefault(st["trip_id"], []).append((int(st["stop_sequence"]), seg(st["arrival_time"]), st["stop_id"]))
# só as viagens com alguma parada dentro do raio
uteis = {}
for tid, ss in seq.items():
    ss.sort()
    dentro = [i for i, (_, _, sid) in enumerate(ss) if sid in paradas and math.hypot(*paradas[sid]) < R]
    if dentro:
        uteis[tid] = (ss, max(0, dentro[0] - 1), min(len(ss) - 1, dentro[-1] + 1))
formas_quero = {viagens[t]["shape_id"] for t in uteis}
formas = {}
for p in ler("shapes.txt"):
    if p["shape_id"] in formas_quero:
        formas.setdefault(p["shape_id"], []).append((int(p["shape_pt_sequence"]), xy(p["shape_pt_lat"], p["shape_pt_lon"])))
freq = {}
for f in ler("frequencies.txt"):
    if f["trip_id"] in uteis:
        freq.setdefault(f["trip_id"], []).append([seg(f["start_time"]), seg(f["end_time"]), int(f["headway_secs"])])

out = []
for tid, (ss, a, b) in uteis.items():
    v, r = viagens[tid], rotas[viagens[tid]["route_id"]]
    pts = [q for _, q in sorted(formas.get(v["shape_id"], []))]
    if len(pts) < 2 or tid not in freq:
        continue
    acum = [0.0]
    for i in range(1, len(pts)):
        acum.append(acum[-1] + math.dist(pts[i - 1], pts[i]))
    # cada parada do trecho no ponto do traçado mais perto, sempre andando para a frente
    idx, j = [], 0
    for _, _, sid in ss[a:b + 1]:
        sx, sy = paradas[sid]
        melhor = min(range(j, min(len(pts), j + 400)), key=lambda i: (pts[i][0] - sx) ** 2 + (pts[i][1] - sy) ** 2)
        idx.append(melhor); j = melhor
    i0, i1 = idx[0], idx[-1]
    if i1 <= i0:
        continue
    p, ultimo = [], None
    for i in range(i0, i1 + 1):   # afina: um ponto a cada ~6 m basta
        if ultimo is None or i == i1 or math.dist(pts[i], ultimo) >= 6:
            p += [round(pts[i][0], 1), round(pts[i][1], 1)]; ultimo = pts[i]
    t0 = ss[a][1]
    out.append({"r": r["route_short_name"], "n": v["trip_headsign"], "c": "#" + (r["route_color"] or "509E2F"), "s": v["service_id"],
                "p": p, "d": [round(acum[i] - acum[i0], 1) for i in idx], "t": [st[1] - t0 for st in ss[a:b + 1]],
                "o": t0 - ss[0][1], "f": freq[tid]})
dias = {c["service_id"]: [int(c[d]) for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")] for c in ler("calendar.txt")}
json.dump({"gerado": datetime.date.today().isoformat(), "fonte": "SPTrans GTFS", "dias": dias, "viagens": out}, open(SAIDA, "w"), separators=(",", ":"))
print(f"{len(out)} viagens no raio, {sum(len(v['p']) for v in out) // 2} pontos de traçado")
