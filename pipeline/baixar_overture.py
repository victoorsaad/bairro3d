# Baixa prédios do Overture Maps (tema buildings) num quadrado de raio + 100 m em volta do centro do config.json.
# Uso: python3 -I baixar_overture.py <saida.parquet>   (precisa de duckdb; lê direto do bucket público na AWS)
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import duckdb
from comum import CFG, LAT0 as LAT, LON0 as LON, RAIO, KX, KY

out = sys.argv[1]
DLAT, DLON = (RAIO + 100) / KY, (RAIO + 100) / KX
REL = CFG.get("overture_release", "2026-09-23.1")
con = duckdb.connect()
con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
con.sql(f"""
COPY (
  SELECT id, height, num_floors, class, subtype, names.primary AS nome,
         sources[1].dataset AS fonte, ST_AsText(geometry) AS wkt
  FROM read_parquet('s3://overturemaps-us-west-2/release/{REL}/theme=buildings/type=building/*', hive_partitioning=1)
  WHERE bbox.xmin > {LON-DLON} AND bbox.xmax < {LON+DLON} AND bbox.ymin > {LAT-DLAT} AND bbox.ymax < {LAT+DLAT}
) TO '{out}' (FORMAT parquet)""")
print(con.sql(f"SELECT fonte, count(*) n, count(height) h FROM '{out}' GROUP BY 1"))
