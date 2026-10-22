# Bairro 3D · Largo da Batata

Maquete 3D de Pinheiros, em São Paulo, num raio de 1 km em volta do Largo da Batata, feita só com dados abertos. [English below](#english)

Prédios, árvores e relevo; zoneamento, manchas de alagamento, transporte, preço do m² (ITBI) e ocorrências criminais, tudo desenhado no navegador com three.js. Sem chave de API, sem serviço pago, sem rastreador: a página e os dados são arquivos estáticos.

## Partes

| Pasta | O que é |
|---|---|
| `config.json` | O lugar: centro (lat/lon), raios e mínimos de agregação. Troque para gerar outro bairro. |
| `pipeline/` | Baixa e processa as bases (`rodar.sh` roda tudo em ordem). |
| `site/` | A página estática (`index.html`, `assets/`); os dados gerados vão em `site/data/`. |
| `serve.py` | Servidor estático com allowlist, CSP e cabeçalhos de segurança. |
| `servidor/` | Unit systemd endurecida de exemplo. |

## Rodando

```bash
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
pipeline/rodar.sh "$PWD/venv/bin/python" "$PWD/raw" "$PWD/site/data"
python3 serve.py            # http://127.0.0.1:8103
```

O download inicial tem ~700 MB (planilhas do ITBI e da SSP, Overture, relevo). LiDAR é opcional: sem ele, as alturas vêm do OSM ou são estimadas.

## Privacidade
Preços e crimes saem só agregados. O ITBI vira mediana do m² por quadra, e quadras com menos de 5 vendas em 24 meses ficam de fora. Os boletins da SSP viram contagens em células de 100 m, e células com menos de 3 ocorrências somem. Nenhuma transação, boletim, nome ou endereço individual é publicado.

## Fontes
© OpenStreetMap contributors (ODbL) · Overture Maps Foundation (ODbL) · Prefeitura de São Paulo: GeoSampa e dados.prefeitura.sp.gov.br · SSP-SP · ANP · Copernicus DEM GLO-30 (© DLR e.V. 2010-2014 e © Airbus Defence and Space GmbH 2014-2018, sob o programa COPERNICUS da União Europeia e da ESA) · three.js (MIT).

Projeto pessoal e educacional, sem afiliação com nenhum órgão público. Os preços do ITBI são valores declarados nas guias e não são avaliação de imóvel.

---

## English

A 3D model of Pinheiros, São Paulo, covering 1 km around Largo da Batata, built only from open data: buildings, trees, terrain, zoning, flood zones, transit, price per m² (ITBI property-transfer tax records) and crime, rendered in the browser with three.js. No API keys, no paid services, no trackers.

Change `config.json` to build another neighbourhood, run `pipeline/rodar.sh`, then `python3 serve.py`. Prices and crime are published only in aggregate: median price per m² per city block (blocks with fewer than 5 sales in 24 months are dropped) and police reports counted in 100 m cells (cells with fewer than 3 reports are dropped).

Personal, educational project with no affiliation to any government body. Code under the MIT license; data under each source's license (see above).
