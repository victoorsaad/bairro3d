#!/usr/bin/env bash
# Roda o pipeline inteiro para o lugar do config.json. Uso: pipeline/rodar.sh <python> <raw> <saida site/data>
# O LiDAR é opcional: só entra se houver folhas MDS 2020 (.zip/.laz, baixadas à mão do GeoSampa) em <raw>/lidar.
set -euo pipefail
PY=${1:?python}; RAW=${2:?raw}; OUT=${3:?saida}
D=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RAW" "$OUT"
run(){ echo "== $*"; "$PY" -I "$@"; }
run "$D/baixar.py" "$RAW"
[ -f "$RAW/overture_extras.json" ] || { run "$D/baixar_overture.py" "$RAW/overture.parquet" && run "$D/extrair_overture_extras.py" "$RAW/overture.parquet" "$RAW/overture_extras.json"; }
run "$D/gerar_bairro.py" "$RAW" "$RAW/bairro_osm.json"
run "$D/gerar_relevo.py" "$RAW" "$OUT"
GRADE=-
if ls "$RAW"/lidar/*.zip "$RAW"/lidar/*.laz >/dev/null 2>&1; then
  [ -f "$RAW/lidar_grade.npz" ] || run "$D/lidar_grade.py" "$RAW/lidar" "$RAW/lidar_grade.npz"
  GRADE="$RAW/lidar_grade.npz"
  run "$D/lidar_predios.py" "$RAW/bairro_osm.json" "$GRADE" "$OUT/bairro.json"
else
  echo "sem LiDAR: alturas do OSM/estimadas"; cp "$RAW/bairro_osm.json" "$OUT/bairro.json"
fi
run "$D/gerar_chunks.py" "$OUT/bairro.json" "$RAW" "$GRADE" "$OUT/chunks"
DEM_TILE=$("$PY" -I -c "import json,math,sys; c=json.load(open('$D/../config.json')); la,lo=c['lat'],c['lon']; print('Copernicus_DSM_COG_10_%s%02d_00_%s%03d_00_DEM'%('S' if la<0 else 'N',abs(math.floor(la)),'W' if lo<0 else 'E',abs(math.floor(lo))))")
[ -f "$RAW/dem.tif" ] || curl -fsSL -o "$RAW/dem.tif" "https://copernicus-dem-30m.s3.amazonaws.com/$DEM_TILE/$DEM_TILE.tif"
run "$D/gerar_entorno.py" "$RAW/dem.tif" "$RAW" "$OUT/relevo.json" "$OUT"
run "$D/gerar_pois.py" "$RAW" "$OUT/pois.json"
P="$RAW/planilhas"
ls "$P"/itbi_*.xlsx >/dev/null 2>&1 || run "$D/baixar_planilhas.py" "$RAW"
run "$D/camadas.py" "$OUT/bairro.json" "$OUT/camadas.json" "$P"/ssp_*.xlsx
run "$D/itbi.py" "$OUT/bairro.json" "$OUT/itbi.json" "$P"/itbi_*.xlsx
run "$D/zoneamento.py" "$OUT/bairro.json" "$OUT/zonas.json" "$P"/ad_*
run "$D/atualizar_postos.py" "$OUT/postos.json" "$RAW"
# GTFS da SPTrans: baixe na área de desenvolvedores (precisa de login) e descompacte em $RAW/gtfs
[ -f "$RAW/gtfs/trips.txt" ] && run "$D/gerar_onibus.py" "$RAW/gtfs" "$OUT/bairro.json" "$OUT/onibus.json"
echo "pronto: $OUT"
