# Baixa as fontes abertas brutas para <raw>/ (cache: o que já existe não é baixado de novo).
#   OpenStreetMap (Overpass): prédios, ruas, áreas, anel de contexto, campos/piscinas, trilhos, lugares e pontos de interesse;
#   GeoSampa (WFS): árvores, curvas de nível e pontos cotados.
# Uso: python3 -I baixar.py <raw>
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import LAT0, LON0, RAIO, ANEL, CFG, overpass, wfs

RAW = sys.argv[1]
os.makedirs(RAW, exist_ok=True)
C = f"{LAT0},{LON0}"
q = lambda corpo, t=300: f"[out:json][timeout:{t}];({corpo});out geom;"

overpass(q(f'way["building"](around:{RAIO+150},{C});relation["building"](around:{RAIO+150},{C});'), f"{RAW}/osm_buildings.json")
overpass(q(f'way["highway"](around:{RAIO+300},{C});'), f"{RAW}/osm_streets.json")
overpass(q(f'nwr["leisure"~"^(park|garden|pitch|playground)$"](around:{RAIO+300},{C});'
           f'nwr["landuse"~"^(grass|forest)$"](around:{RAIO+300},{C});nwr["natural"~"^(water|wood|scrub)$"](around:{RAIO+300},{C});'),
         f"{RAW}/osm_areas.json")
# anel de contexto: só prédios com altura no OSM, ruas de carro, praças e trilhos
overpass(q(f'way["building"]["height"](around:{ANEL+50},{C});relation["building"]["height"](around:{ANEL+50},{C});', 600),
         f"{RAW}/osm_anel_predios.json")
overpass(q(f'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|living_street|unclassified|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](around:{ANEL+100},{C});', 600),
         f"{RAW}/osm_anel_ruas.json")
overpass(q(f'nwr["leisure"~"^(park|garden|pitch|playground)$"](around:{ANEL+150},{C});nwr["landuse"~"^(grass|forest)$"](around:{ANEL+150},{C});'
           f'nwr["natural"~"^(water|wood|scrub)$"](around:{ANEL+150},{C});way["railway"~"^(rail|subway|light_rail|monorail)$"](around:{ANEL+100},{C});', 600),
         f"{RAW}/osm_anel_areas.json")
# entorno: campos, piscinas e pistas (2,7 km); trilhos e estações (4 km); lugares de destaque (4 km)
overpass(q(f'way["leisure"~"^(pitch|swimming_pool|track)$"](around:2700,{C});way["natural"="water"](around:2700,{C});'), f"{RAW}/osm_detalhe.json")
overpass(f'[out:json][timeout:300];(way["railway"~"^(rail|subway|light_rail|monorail)$"](around:4000,{C});'
         f'node["railway"="station"](around:4000,{C}););out geom;', f"{RAW}/osm_trilhos.json")
overpass(q(f'nwr["leisure"~"^(park|stadium|sports_centre)$"]["name"](around:4000,{C});nwr["shop"="mall"]["name"](around:4000,{C});'
           f'nwr["tourism"~"^(museum|attraction)$"]["name"](around:2500,{C});nwr["amenity"~"^(university|marketplace|arts_centre|theatre)$"]["name"](around:2500,{C});'),
         f"{RAW}/osm_lugares.json")
# pontos de interesse do raio principal (só o OSM: nomes e categorias dos próprios mapeadores)
overpass(f'[out:json][timeout:300];(nwr["amenity"](around:{RAIO},{C});nwr["shop"](around:{RAIO},{C});'
         f'nwr["leisure"~"^(fitness_centre|sports_centre|park|playground)$"](around:{RAIO},{C});nwr["healthcare"](around:{RAIO},{C});'
         f'node["railway"="station"](around:{RAIO+300},{C});node["public_transport"="station"](around:{RAIO+300},{C}););out center tags;',
         f"{RAW}/osm_pois.json")

# GeoSampa
wfs("arvore", RAIO + 50, 5000, "cd_identificador", f"{RAW}/geosampa_arvore.json")
R = CFG.get("relevo_m", 2600) + 200
for camada in ("curva_mestra", "curva_intermediaria", "ponto_cotado"):
    wfs(camada, R, 5000, "cd_identificador", f"{RAW}/geosampa_{camada}.json")
print("ok")
