# Baixa as planilhas abertas usadas pelas camadas para <raw>/planilhas (só o que mudou; chave = Last-Modified/ETag):
#   Aprova Digital (SMUL, dados abertos), SSP-SP (dados criminais do ano e do anterior) e ITBI (Fazenda, ~6 anos).
# Uso: python3 -I baixar_planilhas.py <raw>
import sys, os, json, re, html, datetime, urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comum import UA, abre

PASTA = os.path.join(sys.argv[1], "planilhas"); os.makedirs(PASTA, exist_ok=True)
ARQ_EST = f"{PASTA}/estado.json"
estado = json.load(open(ARQ_EST)) if os.path.exists(ARQ_EST) else {}
url_ok = lambda u: urllib.parse.quote(u, safe=":/%?=&")

def baixa(u, nome, chave=None):
    dest = f"{PASTA}/{nome}"
    try:
        if chave is None:
            r = urllib.request.urlopen(urllib.request.Request(url_ok(u), headers={"User-Agent": UA}, method="HEAD"), timeout=120)
            chave = r.headers.get("ETag") or f'{r.headers.get("Last-Modified")}|{r.headers.get("Content-Length")}'
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise
    chave = f"{u}|{chave}"
    if os.path.exists(dest) and estado.get(nome) == chave: return dest
    with open(dest + ".part", "wb") as f: f.write(abre(url_ok(u), t=900))
    os.replace(dest + ".part", dest); estado[nome] = chave
    json.dump(estado, open(ARQ_EST, "w"), indent=1)
    print("baixado", nome, os.path.getsize(dest), flush=True)
    return dest

d = json.loads(abre("https://dados.prefeitura.sp.gov.br/api/3/action/package_show?id=5afd3cf5-29aa-4c5d-8d7f-7780c77a434f"))["result"]
for r in d["resources"]:
    if r["name"].lower().startswith("extrato") and re.search(r"\.(csv|xlsx)$", r["url"], re.I):
        baixa(r["url"], "ad_" + re.sub(r"\W+", "_", r["name"].lower()).strip("_") + os.path.splitext(r["url"])[1].lower(), r.get("last_modified") or r.get("created"))
ano = datetime.date.today().year
for a in (ano - 1, ano):
    baixa(f"https://www.ssp.sp.gov.br/assets/estatistica/transparencia/spDados/SPDadosCriminais_{a}.xlsx", f"ssp_{a}.xlsx")
pag = abre("https://prefeitura.sp.gov.br/web/fazenda/w/acesso_a_informacao/31501").decode("utf-8", "replace")
links = []
for u in re.findall(r'href="([^"]+?\.xlsx)"', pag, re.I):
    u = html.unescape(u)
    if "itbi" in u.lower() and u not in links: links.append(u)
for i, u in enumerate(links[:6]):
    baixa(u, f"itbi_{i}.xlsx")
print("ok")
