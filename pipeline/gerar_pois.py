# Pontos de interesse do raio principal (só o OpenStreetMap) → pois.json: categoria, nome, posição e tipo.
# Uso: python3 -I gerar_pois.py <raw> <saida pois.json>
import os, sys, json, math, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import RAIO, xy

RAW, OUT = sys.argv[1], sys.argv[2]
# [chave, nome pt, nome en, cor]
CATS = [["mercado", "Mercados", "Groceries", "#16a34a"], ["padaria", "Padarias e cafés", "Bakeries and cafés", "#b45309"],
        ["farmacia", "Farmácias", "Pharmacies", "#dc2626"], ["restaurante", "Restaurantes", "Restaurants", "#ea580c"],
        ["fastfood", "Lanches", "Fast food", "#f59e0b"], ["bar", "Bares", "Bars", "#9333ea"],
        ["academia", "Academias e esporte", "Gyms and sports", "#4f46e5"], ["shopping", "Shoppings e lojas de departamento", "Malls", "#db2777"],
        ["saude", "Saúde", "Health", "#0891b2"], ["parque", "Parques e praças", "Parks and squares", "#65a30d"],
        ["transporte", "Metrô e trem", "Metro and rail", "#1d4ed8"], ["cultura", "Cultura", "Culture", "#be185d"],
        ["servicos", "Serviços", "Services", "#0f766e"], ["pet", "Pet", "Pets", "#a16207"], ["escola", "Escolas", "Schools", "#7c3aed"]]
DESLIGADAS = ["restaurante", "fastfood", "bar", "servicos", "escola"]   # começam escondidas para não poluir

def cat(t):
    a, s, l = t.get("amenity"), t.get("shop"), t.get("leisure")
    if s in ("supermarket", "convenience", "greengrocer", "butcher", "deli", "health_food", "organic"): return "mercado"
    if s in ("bakery", "pastry", "coffee") or a == "cafe": return "padaria"
    if a == "pharmacy" or s == "chemist": return "farmacia"
    if a == "restaurant": return "restaurante"
    if a in ("fast_food", "ice_cream", "food_court"): return "fastfood"
    if a in ("bar", "pub", "biergarten", "nightclub"): return "bar"
    if l in ("fitness_centre", "sports_centre"): return "academia"
    if s in ("mall", "department_store"): return "shopping"
    if a in ("hospital", "clinic", "doctors", "dentist") or t.get("healthcare"): return "saude"
    if l in ("park", "playground"): return "parque"
    if t.get("railway") == "station" or t.get("public_transport") == "station": return "transporte"
    if a in ("theatre", "cinema", "arts_centre", "library") or t.get("tourism") == "museum": return "cultura"
    if a in ("bank", "post_office", "place_of_worship", "police", "fire_station", "townhall", "community_centre", "coworking_space"): return "servicos"
    if s == "pet" or a == "veterinary": return "pet"
    if a in ("school", "kindergarten", "university", "college", "language_school"): return "escola"
    return None

out, vistos = [], set()
for e in json.load(open(f"{RAW}/osm_pois.json"))["elements"]:
    t = e.get("tags", {}); n = t.get("name"); c = cat(t)
    if not n or not c: continue
    lat, lon = (e["lat"], e["lon"]) if "lat" in e else (e["center"]["lat"], e["center"]["lon"])
    x, y = xy(lon, lat); m = math.hypot(x, y)
    if m > RAIO + (300 if c == "transporte" else 0): continue
    chave = (c, n.lower(), round(x / 30), round(y / 30))
    if chave in vistos: continue
    vistos.add(chave)
    end = " ".join(v for v in (t.get("addr:street", ""), t.get("addr:housenumber", "")) if v) or None
    tipo = t.get("cuisine", "").split(";")[0].replace("_", " ") if c in ("restaurante", "fastfood") else ""
    out.append({"c": c, "n": n, "x": round(x, 1), "y": round(y, 1), "m": round(m), "t": tipo, "end": end})
out.sort(key=lambda p: p["m"])
json.dump({"gerado": datetime.date.today().isoformat(), "fonte": "OpenStreetMap (ODbL)", "cats": CATS, "desligadas": DESLIGADAS, "lugares": out},
          open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print(len(out), "pontos", {c[0]: sum(p["c"] == c[0] for p in out) for c in CATS})
