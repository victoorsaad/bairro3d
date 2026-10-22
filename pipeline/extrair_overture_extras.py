# Separa do Overture só as construções que NÃO vêm do OSM e não encostam em nenhum prédio OSM (raio + 100 m).
# Uso: python3 -I extrair_overture_extras.py <overture.parquet> <overture_extras.json>
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import duckdb
from comum import LAT0, LON0, RAIO

f, out = sys.argv[1], sys.argv[2]
con = duckdb.connect(); con.sql("INSTALL spatial; LOAD spatial; SET geometry_always_xy = true;")
con.sql(f"CREATE TABLE b AS SELECT *, ST_GeomFromText(wkt) g FROM '{f}'")
rows = con.sql(f"""
WITH osm AS (SELECT g FROM b WHERE fonte = 'OpenStreetMap')
SELECT id, fonte, ST_AsGeoJSON(g) FROM b
WHERE fonte <> 'OpenStreetMap'
  AND ST_Distance_Sphere(ST_Centroid(g), ST_Point({LON0}, {LAT0})) <= {RAIO + 100}
  AND NOT EXISTS (SELECT 1 FROM osm WHERE ST_Intersects(osm.g, b.g))""").fetchall()
json.dump([{"id": r[0], "fonte": r[1], "geom": json.loads(r[2])} for r in rows], open(out, "w"))
print(len(rows), "extras", {r[1] for r in rows})
