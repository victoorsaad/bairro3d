// Maquete 3D de bairro com dados abertos. Centro, raio e nome vêm do config.json do pipeline (gravados em bairro.json → meta).
// x = leste, y = norte em metros a partir do centro; na cena, z = −norte.
import * as THREE from "./vendor/three/three.module.min.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";
import { mergeGeometries } from "./vendor/three/BufferGeometryUtils.js";
import { TessellateModifier } from "./vendor/three/TessellateModifier.js";

const html=document.documentElement, DADOS="data/";
// ---------- idioma e tema: o script do <head> já aplicou o que estava salvo ----------
const EN=()=>html.dataset.lang==="en";
const T=(pt,en)=>EN()?en:pt;                                             // texto puro (aria-label, title, option)
const L=(pt,en)=>`<span lang="pt">${pt}</span><span lang="en">${en}</span>`;   // HTML: o CSS esconde o outro idioma
const aoTrocarIdioma=[];
function idioma(l){
  html.dataset.lang=l; html.lang=l==="pt"?"pt-BR":"en";
  try{ localStorage.setItem("lang",l); }catch(e){}
  document.querySelectorAll("[data-set-lang]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.setLang===l));
  for(const f of aoTrocarIdioma) f();
}
document.querySelectorAll("[data-set-lang]").forEach(b=>b.onclick=()=>idioma(b.dataset.setLang));
idioma(html.dataset.lang==="en"?"en":"pt");
const temaEscuro=()=>html.dataset.theme?html.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
document.getElementById("tema").onclick=()=>{
  const t=temaEscuro()?"light":"dark"; html.dataset.theme=t; try{ localStorage.setItem("theme",t); }catch(e){}
  document.querySelector('meta[name="theme-color"]').content=t==="dark"?"#0d1412":"#f4f1ea";
};

const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const num=(v,d=0)=>L(v.toLocaleString("pt-BR",{maximumFractionDigits:d}),v.toLocaleString("en-US",{maximumFractionDigits:d}));
const distT=m=>m<1000?`${Math.round(m/10)*10} m`:T(`${(m/1000).toFixed(1).replace(".",",")} km`,`${(m/1000).toFixed(1)} km`);
const dist=m=>m<1000?`${Math.round(m/10)*10} m`:L(`${(m/1000).toFixed(1).replace(".",",")} km`,`${(m/1000).toFixed(1)} km`);
const aPe=m=>Math.max(1,Math.round(m*1.3/80));
const aPeTxt=m=>L(`${aPe(m)} min a pé`,`${aPe(m)} min walk`);
const osm=(x,y)=>{ const la=(B.meta.origem.lat+y/B.meta.m_por_grau.lat).toFixed(6), lo=(B.meta.origem.lon+x/B.meta.m_por_grau.lon).toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=18/${la}/${lo}`; };
const brl=n=>"R$ "+Math.round(n).toLocaleString("pt-BR");

const palco=document.getElementById("palco");
const pegar=(arq,obrig)=>fetch(DADOS+arq).then(r=>{ if(!r.ok) throw new Error(arq+" "+r.status); return arq.endsWith(".bin")?r.arrayBuffer():r.json(); })
  .catch(e=>{ if(obrig) throw e; return null; });
const [B,A,RL,IT,ZN,CM]=await Promise.all([
  pegar("bairro.json",true), pegar("pois.json"),
  Promise.all([pegar("relevo.json",true),pegar("relevo.bin",true)]).catch(()=>null),
  pegar("itbi.json"), pegar("zonas.json"), pegar("camadas.json"),
]).catch(e=>{ document.getElementById("carregandoTxt").innerHTML=L(`Não consegui carregar a maquete (${esc(e.message)}). Recarregue a página.`,`Could not load the model (${esc(e.message)}). Please reload.`); throw e; });
const NOME=B.meta.nome||"Centro";
document.getElementById("geradoEm").innerHTML=L(`Dados gerados em ${esc(B.meta.gerado||"")}. Centro: ${esc(NOME)}, raio de ${B.meta.raio_m} m com contexto até ${B.meta.anel_m} m.`,
  `Data generated on ${esc(B.meta.gerado||"")}. Centre: ${esc(NOME)}, ${B.meta.raio_m} m radius with context up to ${B.meta.anel_m} m.`);

// ---------- relevo: altura do terreno (m, relativa ao chão do centro) em x leste / y norte ----------
const RM=RL?.[0], RZ=RL?new Int16Array(RL[1]):null;
function hAt(x,y){
  if(!RZ) return 0;
  const n=RM.n, c=Math.min(n-1.001,Math.max(0,(x-RM.min)/RM.passo)), r=Math.min(n-1.001,Math.max(0,(y-RM.min)/RM.passo));
  const c0=Math.floor(c), r0=Math.floor(r), fc=c-c0, fr=r-r0, i=r0*n+c0;
  return ((RZ[i]*(1-fc)+RZ[i+1]*fc)*(1-fr)+(RZ[i+n]*(1-fc)+RZ[i+n+1]*fc)*fr)/10;
}
const hZ=(x,z)=>hAt(x,-z);   // mesma coisa, em coordenadas da cena
const altitude=m=>Math.round((RM?.base_altitude||0)+m);

// ---------- cena ----------
// aparelho modesto (celular, pouca memória ou poucos núcleos): menos pixels, sombra menor, menos carros
const MODESTO=matchMedia("(pointer:coarse)").matches||(navigator.deviceMemory||8)<=4||(navigator.hardwareConcurrency||8)<=4;
const renderer=new THREE.WebGLRenderer({antialias:!MODESTO,powerPreference:"high-performance"});
renderer.setPixelRatio(Math.min(devicePixelRatio,MODESTO?1.25:1.5));   // 2× (Retina) desenhava 4× os pixels; com antialias, 1,5× quase não muda
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
// a sombra (4096², todos os prédios e árvores) custava um segundo desenho da cena por quadro: agora só refaz quando algo
// muda (sombraJa) ou a cada 500 ms, para pegar o que entrou sem avisar; carros e trens não fazem sombra
renderer.shadowMap.autoUpdate=false; renderer.shadowMap.needsUpdate=true;
const sombraJa=()=>{ renderer.shadowMap.needsUpdate=true; };
renderer.outputColorSpace=THREE.SRGBColorSpace;
palco.prepend(renderer.domElement);
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(40,1,1,60000);
const controls=new OrbitControls(camera,renderer.domElement);
controls.enableDamping=true; controls.dampingFactor=.08;
controls.maxPolarAngle=Math.PI/2-.04; controls.minDistance=15; controls.maxDistance=7500;
controls.autoRotateSpeed=.8;

// x = leste, y = cima, z = sul  (bairro.json: x leste, y norte → z = -y)
const V=(x,y)=>new THREE.Vector2(x,-y);
const pares=p=>{ const o=[]; for(let i=0;i<p.length;i+=2) o.push([p[i],-p[i+1]]); return o; };
// contorno de prédio com as normais das paredes para fora: no plano x/z (z = −norte) a área com sinal tem de ser negativa
const contornoPredio=p=>{ const o=pares(p); let a=0; for(let i=0;i<o.length;i++){ const [x1,z1]=o[i],[x2,z2]=o[(i+1)%o.length]; a+=x1*z2-x2*z1; } return a>0?o.reverse():o; };

const hemi=new THREE.HemisphereLight(0xffffff,0xb9c2cf,1.6); scene.add(hemi);
const sol=new THREE.DirectionalLight(0xfff3e0,2.2);
sol.position.set(-260,420,-180); sol.castShadow=true;
sol.shadow.mapSize.set(MODESTO?2048:4096,MODESTO?2048:4096);
Object.assign(sol.shadow.camera,{left:-450,right:450,top:450,bottom:-450,near:50,far:1800}); sol.shadow.camera.updateProjectionMatrix();   // sem isso a sombra ficava num quadrado de 10 m
sol.shadow.bias=-.0004; sol.shadow.normalBias=.6;
scene.add(sol,sol.target);
const preench=new THREE.DirectionalLight(0xdfe7ff,.7); preench.position.set(300,200,260); scene.add(preench);

// ---------- chão ----------
// terreno: grade de 20 m com o relevo; dentro de 1 km cor de calçada, no anel de contexto (sem as casas) cor de telhado
const chao=(()=>{
  const R=2600, P=20, N=Math.round(2*R/P)+1, pos=[], cor=[], idx=[], corP=[];   // corP: cor de calçada (quando o chunk traz as casas)
  const cA=new THREE.Color(0xe9ece4), cB=new THREE.Color(0xe6d3c0), c=new THREE.Color();
  const vale=new THREE.Color(0xcfdcd6), topo=new THREE.Color(0xf4dfbf);
  const L=new THREE.Vector3(-.55,.62,-.56).normalize(), nrm=new THREE.Vector3();   // luz "de mapa", vinda do noroeste
  for(let j=0;j<N;j++) for(let i=0;i<N;i++){
    const x=-R+i*P, z=-R+j*P, d=Math.hypot(x,z), h=hZ(x,z);
    pos.push(x,h,z);
    c.copy(cA).lerp(cB,Math.min(1,Math.max(0,(d-1030)/40)));
    // tom por altitude: vale mais frio, topo mais quente
    const t=Math.max(-1,Math.min(1,h/35)); c.lerp(t<0?vale:topo,Math.abs(t)*.45);
    // sombreamento: encosta virada para a luz clareia, a oposta escurece (exagerado para o morro aparecer)
    nrm.set(-(hZ(x+P,z)-hZ(x-P,z))/(2*P),1,-(hZ(x,z+P)-hZ(x,z-P))/(2*P)).normalize();
    const k=Math.max(.72,Math.min(1.18,1+5*(nrm.dot(L)-L.y)));
    cor.push(c.r*k,c.g*k,c.b*k);
    c.copy(cA).lerp(t<0?vale:topo,Math.abs(t)*.45); corP.push(c.r*k,c.g*k,c.b*k);
  }
  for(let j=0;j<N-1;j++) for(let i=0;i<N-1;i++){
    const a=j*N+i, x=-R+(i+.5)*P, z=-R+(j+.5)*P;
    if(Math.hypot(x,z)>R) continue;
    idx.push(a,a+N,a+1, a+1,a+N,a+N+1);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3)); g.setAttribute("color",new THREE.Float32BufferAttribute(cor,3));
  g.setIndex(idx); g.computeVertexNormals();
  const me=new THREE.Mesh(g,new THREE.MeshLambertMaterial({vertexColors:true})); me.receiveShadow=true;
  me.userData={R,P,N,corOrig:Float32Array.from(cor),corPerto:Float32Array.from(corP)}; return me;
})();
scene.add(chao);
const curvas=new THREE.Group(); scene.add(curvas);
const matCurva=new THREE.LineBasicMaterial({color:0x8a6f55,transparent:true,opacity:.28,depthWrite:false});
const matMestra=new THREE.LineBasicMaterial({color:0x7a5d43,transparent:true,opacity:.5,depthWrite:false});
if(RM?.curvas){
  const seg={f:[],m:[]};
  for(const cv of RM.curvas){
    const alvo=cv.z%10===0?seg.m:seg.f, q=pares(cv.p);
    for(let i=0;i<q.length-1;i++){
      const [x1,z1]=q[i],[x2,z2]=q[i+1];
      if(Math.hypot(x1,z1)>2600||Math.hypot(x2,z2)>2600) continue;
      alvo.push(x1,hZ(x1,z1)+.6,z1,x2,hZ(x2,z2)+.6,z2);
    }
  }
  for(const [k,m] of [["f",matCurva],["m",matMestra]]){
    const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(seg[k],3));
    const l=new THREE.LineSegments(g,m); l.renderOrder=1; curvas.add(l);
  }
}

performance.mark("b3-chao0");
// ---------- texturas de fachada: 3 estilos, cada um com versão de dia (vidro) e de noite (algumas acesas) ----------
// 0 = janelas em grade · 1 = faixas contínuas com varanda · 2 = pares de janelas altas
function texJanelas(noite,estilo){
  const N=8, S=32, c=document.createElement("canvas"); c.width=c.height=N*S;
  const g=c.getContext("2d");
  const parede=noite?"#4a5280":"#fff", vidro=noite?"#262b4a":"#9fb1c6", varanda=noite?"#3d446c":"#d9dde4";
  g.fillStyle=parede; g.fillRect(0,0,N*S,N*S);   // à noite: a própria parede, sem depender da luz
  let semente=7+estilo*101; const rnd=()=>(semente=(semente*16807)%2147483647)/2147483647;
  const luz=()=>rnd()<.42?(rnd()<.7?"#ffd27a":"#fff1c9"):vidro;
  for(let j=0;j<N;j++){
    if(estilo===1){ g.fillStyle=varanda; g.fillRect(0,j*S+S-7,N*S,4); }
    for(let i=0;i<N;i++){
      if(!noite) g.fillStyle=vidro;
      if(estilo===0){ if(noite) g.fillStyle=luz(); g.fillRect(i*S+8,j*S+7,S-16,S-14); }
      else if(estilo===1){ if(noite) g.fillStyle=luz(); g.fillRect(i*S+1,j*S+8,S-2,S-17); if(!noite){ g.fillStyle="#b9c6d6"; g.fillRect(i*S+S-2,j*S+8,2,S-17);} }
      else { for(const dx of [6,18]){ if(noite) g.fillStyle=luz(); g.fillRect(i*S+dx,j*S+5,8,S-11); } }
    }
  }
  const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=4; return t;
}
const ESTILOS=3;
const TEX=[0,1,2].map(e=>({dia:texJanelas(false,e),noite:texJanelas(true,e)}));
const JAN_W=3.2, JAN_H=3.0, JAN_N=8;   // metros por janela (largura) e por andar; a textura tem 8×8 janelas

// ---------- prédios: poucas malhas (fachadas de 3 estilos, paredes lisas, telhados) ----------
const hash=(i,k)=>{   // número "aleatório" estável entre 0 e 1 para o item i (k escolhe a sequência)
  let h=Math.imul((i+1)^Math.imul(k,0x9E3779B1),0x85EBCA6B); h^=h>>>13; h=Math.imul(h,0xC2B2AE35); h^=h>>>16;
  return (h>>>0)/4294967296;
};
const corPredio=(h,i)=>{
  const r=hash(i,2654435761);
  if(h>=12) return new THREE.Color().setHSL([.6,.08,.55,.1][Math.floor(r*4)],.1+.1*r,.84+.08*r);   // concreto, areia, azulado, creme
  const paleta=[0xf3e3c3,0xf0d2b4,0xe9e4d8,0xf5ecd9,0xe3d5c1,0xf2dccb,0xdfe6dc,0xf1d9d0];
  return new THREE.Color(paleta[Math.floor(r*paleta.length)]);
};
const corTelhado=(h,i)=>{
  const r=hash(i,2246822519);
  if(h>=12) return new THREE.Color().setHSL(.6,.05,.66+.1*r);
  return new THREE.Color([0xc98a68,0xb9765a,0xd29a76,0xbf6f55,0xa9a9a2,0xc4825f][Math.floor(r*6)]);
};

const predios=[...B.predios,...(B.anel?.predios||[]).map(b=>({...b,anel:1}))];
const CHAVES=["jan0","jan1","jan2","lisa","tel"];
// acumulador em Float32Array que dobra de tamanho (listas comuns gastam 8 bytes por número e chegavam a ~400 MB)
class Cresce{
  constructor(n=1<<15){ this.a=new Float32Array(n); this.n=0; }
  push(){ if(this.n+arguments.length>this.a.length){ const b=new Float32Array(this.a.length*2); b.set(this.a); this.a=b; }
    for(let i=0;i<arguments.length;i++) this.a[this.n++]=arguments[i]; }
  fim(){ const r=this.a.slice(0,this.n); this.a=null; return r; }
}
const novoBuf=()=>({p:new Cresce(),n:new Cresce(),uv:new Cresce(),c:new Cresce()});
let buf=Object.fromEntries(CHAVES.map(k=>[k,novoBuf()]));
let triDono=Object.fromEntries(CHAVES.map(k=>[k,[]]));   // índice do prédio de cada triângulo (para o clique)
const tri=(k,dono,vs,nrm,cor)=>{   // vs = [[x,y,z,u,v]×3]; nrm = [nx,ny,nz] ou null (calcula)
  const d=buf[k]||(buf[k]=novoBuf());
  let n=nrm;
  if(!n){ const [a,b,c]=vs; const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], w=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
    n=[u[1]*w[2]-u[2]*w[1],u[2]*w[0]-u[0]*w[2],u[0]*w[1]-u[1]*w[0]]; const L=Math.hypot(...n)||1; n=n.map(v=>v/L);
    if(n[1]<0){ vs=[vs[0],vs[2],vs[1]]; if(Array.isArray(cor)) cor=[cor[0],cor[2],cor[1]]; n=n.map(v=>-v); } }   // telhado: sempre virado para cima
  for(let j=0;j<3;j++){ const v=vs[j]; d.p.push(v[0],v[1],v[2]); d.n.push(n[0],n[1],n[2]); d.uv.push(v[3]||0,v[4]||0); const cc=Array.isArray(cor)?cor[j]:cor; d.c.push(cc.r,cc.g,cc.b); }
  if(triDono[k]) triDono[k].push(dono);
};
// parede com degradê: a base é mais escura (imita a sombra de contato no chão)
function parede(k,dono,pts,h0,h1,cor,ref=0,escurece=.78){
  const baixo=cor.clone().multiplyScalar(escurece);
  let u=0;
  for(let i=0;i<pts.length;i++){
    const [x1,z1]=pts[i], [x2,z2]=pts[(i+1)%pts.length];
    const L=Math.hypot(x2-x1,z2-z1); if(L<.01) continue;
    const n=[-(z2-z1)/L,0,(x2-x1)/L];   // anel anti-horário no plano x/norte → normal para fora em x/z
    const u0=u/JAN_W/JAN_N, u1=(u+L)/JAN_W/JAN_N, v0=(h0-ref)/JAN_H/JAN_N, v1=(h1-ref)/JAN_H/JAN_N; u+=L;
    tri(k,dono,[[x1,h0,z1,u0,v0],[x2,h0,z2,u1,v0],[x2,h1,z2,u1,v1]],n,[baixo,baixo,cor]);
    tri(k,dono,[[x1,h0,z1,u0,v0],[x2,h1,z2,u1,v1],[x1,h1,z1,u0,v1]],n,[baixo,cor,cor]);
  }
}
function tampa(k,dono,pts,h,cor){
  let tris; try{ tris=THREE.ShapeUtils.triangulateShape(pts.map(([x,z])=>new THREE.Vector2(x,z)),[]); }catch(e){ return; }
  for(let t of tris){
    const [a,b,c]=t.map(i=>pts[i]);   // a face tem de olhar para cima
    if((b[1]-a[1])*(c[0]-a[0])-(b[0]-a[0])*(c[1]-a[1])<0) t=[t[0],t[2],t[1]];
    tri(k,dono,t.map(i=>[pts[i][0],h,pts[i][1]]),[0,1,0],cor);
  }
}
const centroDe=pts=>pts.reduce((a,[x,z])=>[a[0]+x/pts.length,a[1]+z/pts.length],[0,0]);
const areaDe=pts=>Math.abs(pts.reduce((s,[x,z],i)=>{ const [x2,z2]=pts[(i+1)%pts.length]; return s+x*z2-x2*z; },0)/2);
const convexo=pts=>{ let s=0; for(let i=0;i<pts.length;i++){ const [a,b,c]=[pts[i],pts[(i+1)%pts.length],pts[(i+2)%pts.length]];
  const cr=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]); if(Math.abs(cr)<1e-6) continue; if(s&&Math.sign(cr)!==s) return false; s=Math.sign(cr); } return true; };
const encolhe=(pts,c,f)=>pts.map(([x,z])=>[c[0]+(x-c[0])*f,c[1]+(z-c[1])*f]);
// telhado de quatro águas (aproximado): o contorno sobe até uma cópia menor no centro
function telhadoInclinado(dono,pts,h,cor){
  const c=centroDe(pts), A=areaDe(pts), r=Math.min(2.6,Math.max(1.1,Math.sqrt(A)*.16));
  const topo=encolhe(pts,c,.32), claro=cor.clone().multiplyScalar(1.06);
  for(let i=0;i<pts.length;i++){
    const j=(i+1)%pts.length, [x1,z1]=pts[i],[x2,z2]=pts[j],[t1,s1]=topo[i],[t2,s2]=topo[j];
    tri("tel",dono,[[x1,h,z1],[x2,h,z2],[t2,h+r,s2]],null,cor);
    tri("tel",dono,[[x1,h,z1],[t2,h+r,s2],[t1,h+r,s1]],null,cor);
  }
  tampa("tel",dono,topo,h+r,claro);
}
// contorno deslocado d metros para fora (esquina em meia-esquadria, limitada nas pontas agudas)
function desloca(pts,d){
  return pts.map(([x,z],i)=>{
    const [xa,za]=pts[(i-1+pts.length)%pts.length],[xb,zb]=pts[(i+1)%pts.length];
    const La=Math.hypot(x-xa,z-za)||1, Lb=Math.hypot(xb-x,zb-z)||1;
    const n1=[-(z-za)/La,(x-xa)/La], n2=[-(zb-z)/Lb,(xb-x)/Lb];
    const k=Math.min(2.5,1/Math.max(.4,(1+n1[0]*n2[0]+n1[1]*n2[1])/2));
    const mx=(n1[0]+n2[0])/2, mz=(n1[1]+n2[1])/2;
    return [x+mx*d*k,z+mz*d*k];
  });
}
// faixa horizontal entre dois contornos (a e b) na altura y, virada para cima ou para baixo
function anelPlano(k,dono,a,b,y,cor,cima=true){
  for(let i=0;i<a.length;i++){ const j=(i+1)%a.length;
    const q=[[a[i][0],y,a[i][1]],[a[j][0],y,a[j][1]],[b[j][0],y,b[j][1]],[b[i][0],y,b[i][1]]];
    const n=[0,cima?1:-1,0];
    for(let t of [[q[0],q[1],q[2]],[q[0],q[2],q[3]]]){
      const ny=(t[1][2]-t[0][2])*(t[2][0]-t[0][0])-(t[1][0]-t[0][0])*(t[2][2]-t[0][2]);   // componente y do produto vetorial
      if((ny>0)!==cima) t=[t[0],t[2],t[1]];
      tri(k,dono,t,n,cor);
    }
  }
}
// arestas das torres (quinas + topo), discretas
let arestas=[];
// torre "de verdade": laje saliente em cada andar, mureta na cobertura e arestas marcadas
// as lajes de cada andar vão para blocos de 250 m que só aparecem com a câmera perto (eram ~40% dos triângulos)
const BLOCO_LAJE=250;
let lajeFixa=null;   // chunks: todas as lajes do quadrado numa malha só (menos objetos para desenhar)
function detalhaTorre(i,pts,z0,h,cor){
  const fora=desloca(pts,.32), mureta=desloca(pts,.12), dentro=desloca(pts,-.18);
  const laje=cor.clone().lerp(new THREE.Color(0xffffff),.35), sombra=cor.clone().multiplyScalar(.7);
  const c=centroDe(pts), kb=lajeFixa||`laje:${Math.floor(c[0]/BLOCO_LAJE)}:${Math.floor(c[1]/BLOCO_LAJE)}`;
  for(let y=z0+JAN_H;y<z0+h-1.5;y+=JAN_H){
    parede(kb,i,fora,y-.2,y+.18,laje,0,.92);
    anelPlano(kb,i,pts,fora,y+.18,laje,true);
  }
  // mureta: face de fora, face de dentro e topo (assim não parece uma casca vazada vista de cima)
  parede("lisa",i,mureta,z0+h-.4,z0+h+1.1,laje,0,1);
  parede("lisa",i,[...dentro].reverse(),z0+h,z0+h+1.1,sombra,0,1);
  anelPlano("lisa",i,dentro,mureta,z0+h+1.1,laje,true);
  // arestas: quinas com mudança de direção > 25° e o contorno do topo
  for(let k=0;k<mureta.length;k++){
    const [x,z]=mureta[k],[xa,za]=mureta[(k-1+mureta.length)%mureta.length],[xb,zb]=mureta[(k+1)%mureta.length];
    const a1=Math.atan2(z-za,x-xa), a2=Math.atan2(zb-z,xb-x); let da=Math.abs(a2-a1); if(da>Math.PI) da=2*Math.PI-da;
    if(da>.44) arestas.push(x,z0,z, x,z0+h+1.1,z);
    arestas.push(x,z0+h+1.1,z, xb,z0+h+1.1,zb);
  }
}
// cor do telhado tirada da foto aérea do LiDAR 2020 (vem apagada: um pouco mais de saturação, sem extremos)
const hslTmp={};
const corReal=hex=>{ const c=new THREE.Color("#"+hex); c.getHSL(hslTmp);
  return c.setHSL(hslTmp.h,Math.min(.62,hslTmp.s*1.35),Math.min(.86,Math.max(.24,hslTmp.l*1.04))); };
// base = ponto mais baixo do terreno sob o prédio; a parede começa 1 m abaixo para não sobrar fresta na ladeira
const baseDe=pts=>Math.min(...pts.map(([x,z])=>hZ(x,z)));
// prédios com fachada própria (fachadas.json + o "predio" de cada Pessoa em pontos.json): saem da malha comum
const dentroDe=(x,y,p)=>{ let d=false; for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){ const xi=p[i],yi=p[i+1],xj=p[j],yj=p[j+1];
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi) d=!d; } return d; };
performance.mark("b3-tex");
// grade de 100 m com os prédios (pelo retângulo envolvente) e o centro de cada um: as buscas de "qual prédio contém
// este ponto" olham só as células em volta em vez de varrer os 13 mil (eram ~0,5 s na abertura)
const GRADE_P=100, gradeP=new Map();
predios.forEach((b,i)=>{ let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9,sx=0,sy=0; const n=b.p.length/2;
  for(let k=0;k<b.p.length;k+=2){ const x=b.p[k],y=b.p[k+1]; sx+=x; sy+=y; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
  b._i=i; b.cx=sx/n; b.cy=sy/n;
  for(let gx=Math.floor(x0/GRADE_P);gx<=Math.floor(x1/GRADE_P);gx++) for(let gy=Math.floor(y0/GRADE_P);gy<=Math.floor(y1/GRADE_P);gy++){
    const k=gx+","+gy; (gradeP.get(k)||gradeP.set(k,[]).get(k)).push(b); } });
function pertoDe(x,y,r){   // prédios cujo retângulo cai nas células a até r metros do ponto (na ordem da lista)
  const vistos=new Set();
  for(let gx=Math.floor((x-r)/GRADE_P);gx<=Math.floor((x+r)/GRADE_P);gx++) for(let gy=Math.floor((y-r)/GRADE_P);gy<=Math.floor((y+r)/GRADE_P);gy++)
    for(const b of gradeP.get(gx+","+gy)||[]) vistos.add(b);
  return [...vistos].sort((a,b)=>a._i-b._i);
}
// detalhe = lajes por andar nas torres ≥ 18 m (no anel, só quando o chunk da região carrega)
function construirPredio(b,i,detalhe=!b.anel){
  const pts=contornoPredio(b.p), h=b.h, z0=b.base=baseDe(pts), cor=corPredio(h,i), ct=b.c?corReal(b.c):corTelhado(h,i);
  if(b.esp||b.oculto) return;
  if(b.t==="cobertura"){ parede("lisa",i,pts,z0+Math.max(0,h-.5),z0+h,cor,z0,1); tampa("tel",i,pts,z0+h,ct); return; }
  const torre=h>=9&&b.t!=="subsolo";
  parede(torre?"jan"+Math.floor(hash(i,40503)*ESTILOS):"lisa",i,pts,z0-1,z0+h,cor,z0,torre?.84:.74);
  const A=areaDe(pts);
  if(!torre&&h<9&&A<450&&pts.length<=10&&convexo(pts)&&b.t!=="subsolo"&&hash(i,97)<.8) telhadoInclinado(i,pts,z0+h,ct);
  else tampa("tel",i,pts,z0+h,ct);
  if(torre&&h>=18&&detalhe) detalhaTorre(i,pts,z0,h,cor);
  // torre: casa de máquinas/caixa d'água no topo
  if(h>=20&&A>120&&convexo(pts)){
    const c=centroDe(pts), cm=encolhe(pts,c,.38), hc=3.2+hash(i,31)*1.6;
    parede("lisa",i,cm,z0+h,z0+h+hc,ct.clone().multiplyScalar(1.05),z0,.9); tampa("tel",i,cm,z0+h+hc,ct.clone().multiplyScalar(.92));
  }
}
performance.mark("b3-chao");
predios.forEach((b,i)=>construirPredio(b,i));
performance.mark("b3-predios");
const espMeshes=[], matsEsp=[];   // (a versão original tinha prédios com fachada própria; aqui não há)

// depois de ir para a placa de vídeo, a cópia na memória do navegador é descartada (só a posição fica, para o clique)
function soltaDepois(){ this.array=null; }
function geo(d){
  const g=new THREE.BufferGeometry();
  g.setAttribute("position",new THREE.BufferAttribute(d.p.fim(),3));
  g.setAttribute("normal",new THREE.BufferAttribute(d.n.fim(),3).onUpload(soltaDepois));
  g.setAttribute("uv",new THREE.BufferAttribute(d.uv.fim(),2).onUpload(soltaDepois));
  g.setAttribute("color",new THREE.BufferAttribute(d.c.fim(),3).onUpload(soltaDepois));
  return g;
}
const matJan=TEX.map(t=>new THREE.MeshLambertMaterial({vertexColors:true,map:t.dia,emissive:0xffffff,emissiveMap:t.noite,emissiveIntensity:0}));
const matLisa=new THREE.MeshLambertMaterial({vertexColors:true});
const matTel=new THREE.MeshLambertMaterial({vertexColors:true});
const malhas={};
for(const [k,m] of [["jan0",matJan[0]],["jan1",matJan[1]],["jan2",matJan[2]],["lisa",matLisa],["tel",matTel]]){
  const me=new THREE.Mesh(geo(buf[k]),m); me.castShadow=me.receiveShadow=true; me.userData.tipo=k;
  // o clique usa só as posições (normais, uv e cores saem da memória depois de ir para a GPU e o raycast tentaria lê-las)
  const soPos=new THREE.BufferGeometry(); soPos.setAttribute("position",me.geometry.attributes.position);
  me.raycast=(rc,out)=>{ const g=me.geometry; me.geometry=soPos; THREE.Mesh.prototype.raycast.call(me,rc,out); me.geometry=g; };
  scene.add(me); malhas[k]=me;
}
const lajesLOD=[];
for(const k of Object.keys(buf).filter(k=>k.startsWith("laje:"))){
  const [,bx,bz]=k.split(":").map(Number), me=new THREE.Mesh(geo(buf[k]),matLisa);
  me.castShadow=true; me.receiveShadow=true; me.raycast=()=>{}; scene.add(me);
  lajesLOD.push({m:me,c:new THREE.Vector3((bx+.5)*BLOCO_LAJE,0,(bz+.5)*BLOCO_LAJE)});
}
buf=null;
for(const k of CHAVES) triDono[k]=Uint32Array.from(triDono[k]);
const malhasPredios=[...Object.values(malhas),...espMeshes];
const matAresta=new THREE.LineBasicMaterial({color:0x5c6678,transparent:true,opacity:.55});
{ const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(arestas,3)); scene.add(new THREE.LineSegments(g,matAresta)); arestas.length=0; }

performance.mark("b3-malhas");
// ---------- ruas (fitas com juntas redondas) e áreas verdes ----------
const COR_AREA={parque:0xa8d98f,grama:0xbfe3a5,quadra:0xd3b98f,playground:0xe6c58f,mata:0x86c06f,agua:0x8cc4e8};
const areasGeo={};
for(const a of [...B.areas,...(B.anel?.areas||[])]){
  const pts=pares(a.p).map(([x,z])=>new THREE.Vector2(x,-z));   // Shape no plano x/norte
  let g=new THREE.ShapeGeometry(new THREE.Shape(pts)).rotateX(-Math.PI/2).toNonIndexed();
  g=new TessellateModifier(14,6).modify(g);   // triângulos de até ~14 m, para acompanhar o relevo
  g.deleteAttribute("uv");
  const P=g.attributes.position;
  for(let i=0;i<P.count;i++) P.setY(i,hZ(P.getX(i),P.getZ(i))+.25);
  g.computeVertexNormals();
  (areasGeo[a.k]||(areasGeo[a.k]=[])).push(g);
}
for(const [k,gs] of Object.entries(areasGeo)){
  const me=new THREE.Mesh(mergeGeometries(gs),new THREE.MeshLambertMaterial({color:COR_AREA[k]||0xa8d98f}));
  me.receiveShadow=true; scene.add(me);
}
function fita(ruas,y,hf=hZ){
  const P=[];
  const Y=(x,z)=>hf(x,z)+y+.2;
  const disco=(x,z,r)=>{ const n=10; for(let i=0;i<n;i++){ const a0=i/n*Math.PI*2, a1=(i+1)/n*Math.PI*2;
    const h=Y(x,z); P.push(x,h,z, x+Math.cos(a1)*r,h,z+Math.sin(a1)*r, x+Math.cos(a0)*r,h,z+Math.sin(a0)*r); } };
  for(const r of ruas){
    const pts=[], w=r.w/2;
    { const q=pares(r.p);   // adensa para o asfalto seguir o morro
      for(let i=0;i<q.length-1;i++){ const [x1,z1]=q[i],[x2,z2]=q[i+1], n=Math.max(1,Math.ceil(Math.hypot(x2-x1,z2-z1)/10));
        for(let k=0;k<n;k++) pts.push([x1+(x2-x1)*k/n,z1+(z2-z1)*k/n]); }
      if(q.length) pts.push(q[q.length-1]); }
    for(let i=0;i<pts.length-1;i++){
      const [x1,z1]=pts[i],[x2,z2]=pts[i+1], L=Math.hypot(x2-x1,z2-z1); if(L<.01) continue;
      const nx=-(z2-z1)/L*w, nz=(x2-x1)/L*w;
      const a=Y(x1,z1), b=Y(x2,z2);
      P.push(x1+nx,a,z1+nz, x2-nx,b,z2-nz, x2+nx,b,z2+nz,  x1+nx,a,z1+nz, x1-nx,a,z1-nz, x2-nx,b,z2-nz);
    }
    for(let i=0;i<pts.length;i+=4) disco(pts[i][0],pts[i][1],w);   // juntas (não precisa em todo ponto adensado)
    if(pts.length) disco(...pts[pts.length-1],w);
  }
  const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(P,3)); g.computeVertexNormals();
  return g;
}
const PEDESTRE=new Set(["footway","path","steps","cycleway","pedestrian"]);
const matRua=new THREE.MeshLambertMaterial({color:0x9aa1ad,side:THREE.DoubleSide}), matCalcada=new THREE.MeshLambertMaterial({color:0xd8d4cb,side:THREE.DoubleSide});
const todasRuas=[...B.ruas,...(B.anel?.ruas||[])];
const ruasMesh=new THREE.Mesh(fita(todasRuas.filter(r=>!PEDESTRE.has(r.k)),.09),matRua);
const calcMesh=new THREE.Mesh(fita(B.ruas.filter(r=>PEDESTRE.has(r.k)),.07),matCalcada);
ruasMesh.receiveShadow=calcMesh.receiveShadow=true; scene.add(ruasMesh,calcMesh);
const matTrilho=new THREE.MeshLambertMaterial({color:0x7d6f66,side:THREE.DoubleSide});
if(B.anel?.trilhos?.length) scene.add(new THREE.Mesh(fita(B.anel.trilhos.map(t=>({...t,w:4})),.11),matTrilho));

let nivelEm=null;   // trânsito ao vivo (definido mais abaixo); 1 = livre
// ---------- calçadas e faixas pintadas ----------
// calçada = uma fita mais larga e clara por baixo do asfalto (só dentro de 1 km, onde há casas)
const VIAS=new Set(["motorway","trunk","primary","secondary","tertiary","residential","living_street","unclassified","trunk_link","primary_link","secondary_link","tertiary_link"]);
const matPasseio=new THREE.MeshLambertMaterial({color:0xdcd8cf,side:THREE.DoubleSide});
{ const m=new THREE.Mesh(fita(B.ruas.filter(r=>VIAS.has(r.k)).map(r=>({...r,w:r.w+3.4})),.03),matPasseio); m.receiveShadow=true; scene.add(m); }
// polilinhas adensadas (a cada ~6 m) com comprimento acumulado: usadas pelas faixas, pelos postes e pelos carros
function caminho(r){
  const q=pares(r.p), pts=[];
  for(let i=0;i<q.length-1;i++){ const [x1,z1]=q[i],[x2,z2]=q[i+1], n=Math.max(1,Math.ceil(Math.hypot(x2-x1,z2-z1)/6));
    for(let k=0;k<n;k++) pts.push([x1+(x2-x1)*k/n,z1+(z2-z1)*k/n]); }
  if(q.length) pts.push(q[q.length-1]);
  const s=[0]; for(let i=1;i<pts.length;i++) s.push(s[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
  return {pts,s,L:s[s.length-1],r};
}
function ponto(c,d){   // posição e direção a d metros do início do caminho
  let i=1; while(i<c.s.length-1&&c.s[i]<d) i++;
  const [x1,z1]=c.pts[i-1],[x2,z2]=c.pts[i], t=Math.min(1,Math.max(0,(d-c.s[i-1])/((c.s[i]-c.s[i-1])||1)));
  return [x1+(x2-x1)*t,z1+(z2-z1)*t,Math.atan2(x2-x1,z2-z1)];
}
const avenidas=todasRuas.filter(r=>r.w>=9&&VIAS.has(r.k)).map(caminho).filter(c=>c.L>40);
{ // faixa central tracejada: 3 m pintados a cada 9 m
  const P=[];
  for(const c of avenidas) for(let d=4;d<c.L-4;d+=9){
    const [x,z,a]=ponto(c,d), dx=Math.sin(a)*1.5, dz=Math.cos(a)*1.5, ex=Math.cos(a)*.13, ez=-Math.sin(a)*.13;
    const y1=hZ(x-dx,z-dz)+.36, y2=hZ(x+dx,z+dz)+.36;
    P.push(x-dx+ex,y1,z-dz+ez, x+dx-ex,y2,z+dz-ez, x+dx+ex,y2,z+dz+ez,  x-dx+ex,y1,z-dz+ez, x-dx-ex,y1,z-dz-ez, x+dx-ex,y2,z+dz-ez);
  }
  const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(P,3));
  scene.add(new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xf3f1e8,side:THREE.DoubleSide,transparent:true,opacity:.85})));
}

performance.mark("b3-ruas");
// ---------- entorno: relevo real até 24 km (o que existe depois dos 2,6 km da maquete) ----------
// Relevo do Copernicus DEM GLO-30 (ao longe, exagerado até 1,6× para as serras aparecerem na escala da tela), tingido pela
// altitude: a mancha urbana de São Paulo fica abaixo de ~880 m; acima, serras e matas. Sem imagem de satélite.
// x = leste, z = −norte; azimute θ a partir do norte, no sentido horário.
const entornoP=Promise.all([pegar("entorno.json",true),pegar("entorno.bin",true)]).catch(()=>null);
const horizonte=(()=>{
  let sd=11; const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;
  const R0=2560, R1=24000, AZ=(th,r)=>[Math.sin(th)*r,-Math.cos(th)*r];
  const suave=(a,b,v)=>{ const t=Math.min(1,Math.max(0,(v-a)/(b-a))); return t*t*(3-2*t); };
  const grupo=new THREE.Group(); scene.add(grupo);
  let EM=null, EZ=null, noiteH=false, partes=null;
  function hDem(x,y){ const n=EM.n, c=Math.min(n-1.001,Math.max(0,(x-EM.min)/EM.passo)), r=Math.min(n-1.001,Math.max(0,(y-EM.min)/EM.passo));
    const c0=Math.floor(c), r0=Math.floor(r), fc=c-c0, fr=r-r0, i=r0*n+c0;
    return ((EZ[i]*(1-fc)+EZ[i+1]*fc)*(1-fr)+(EZ[i+n]*(1-fc)+EZ[i+n+1]*fc)*fr)/10; }
  // altura em qualquer ponto da cena: dentro, o relevo do GeoSampa; na borda, emenda nele; para fora, o DEM
  function h(x,z){ const d=Math.hypot(x,z)||1; if(d<R0-30||!EM) return hZ(x,z);
    const b=hZ(x/d*(R0-20),z/d*(R0-20)), t=suave(R0,R0+900,d), ex=1+.6*suave(4000,12000,d);
    return b*(1-t)+hDem(x,-z)*ex*t; }
  const BASE=()=>RM?.base_altitude||EM?.base||760;
  const urbano=(x,z)=>EM&&BASE()+hDem(x,-z)<880;
  function construir(){
    // chão: anel de 2,52 a 24 km; cor da maquete que vira, aos poucos, um mapa de altitude (cidade bege, serra verde)
    const NA=360, rs=[]; for(let r=R0-40;r<R1;r*=1.035) rs.push(r); rs.push(R1);
    const pos=[], cor=[], idx=[], c0=new THREE.Color(0xe6d3c0), cid=new THREE.Color(0xe2d9cb), mata=new THREE.Color(0xa9c39a), c=new THREE.Color(), t=new THREE.Color();
    for(const r of rs) for(let i=0;i<NA;i++){ const [x,z]=AZ(i/NA*Math.PI*2,r); pos.push(x,h(x,z)-.6,z);
      const alt=BASE()+hDem(x,-z), m=suave(R0,R0+1400,r);
      t.copy(cid).lerp(mata,suave(860,960,alt)); c.copy(c0).lerp(t,m); cor.push(c.r,c.g,c.b); }
    for(let j=0;j<rs.length-1;j++) for(let i=0;i<NA;i++){ const a=j*NA+i, b=j*NA+(i+1)%NA; idx.push(a,b,a+NA, b,b+NA,a+NA); }
    const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(pos,3)); g.setAttribute("color",new THREE.Float32BufferAttribute(cor,3));
    g.setIndex(idx); g.computeVertexNormals();
    const matChao=new THREE.MeshLambertMaterial({vertexColors:true});
    const chaoFora=new THREE.Mesh(g,matChao); chaoFora.raycast=()=>{}; grupo.add(chaoFora);

    // cidade distante (até ~8 km): caixas instanciadas, mais altas para o lado do Centro e da Paulista
    const CENTRO_SP=Math.atan2((-46.6333-B.meta.origem.lon)*B.meta.m_por_grau.lon,(-23.5505-B.meta.origem.lat)*B.meta.m_por_grau.lat), itens=[];
    for(let k=0;k<9000&&itens.length<3800;k++){
      const th=rnd()*Math.PI*2, foco=Math.max(0,Math.cos(th-CENTRO_SP)), r=R0+120+Math.pow(rnd(),.85)*(4800+foco*2600);
      if(rnd()>Math.max(.3,1-(r-R0)/(7000+foco*5000))) continue;
      const [x,z]=AZ(th,r); if(!urbano(x,z)) continue;
      const alto=rnd()<.12+foco*.35;
      const hh=alto?35+rnd()*(60+foco*110):8+rnd()*16, w=alto?14+rnd()*16:16+rnd()*26, d=alto?14+rnd()*16:14+rnd()*24;
      itens.push({x,z,h:hh,w,d,rot:rnd()*Math.PI,r,y0:h(x,z)});
    }
    const geo=new THREE.BoxGeometry(1,1,1).translate(0,.5,0);
    const matCid=new THREE.MeshLambertMaterial({color:0xffffff});
    const cidade=new THREE.InstancedMesh(geo,matCid,Math.max(1,itens.length));
    const m4=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler();
    itens.forEach((it,i)=>{ q.setFromEuler(e.set(0,it.rot,0)); m4.compose(new THREE.Vector3(it.x,it.y0-1,it.z),q,new THREE.Vector3(it.w,it.h,it.d));
      cidade.setMatrixAt(i,m4); c.setHSL(.6,.06,it.h>30?.86:.8+((i%7)*.012)); if(it.h<=30&&i%3===0) c.setHex(0xd9a27e); cidade.setColorAt(i,c); });
    cidade.count=itens.length; cidade.raycast=()=>{}; grupo.add(cidade);

    // luzes à noite: janelas das caixas + tapete de pontos sobre a área urbana, até o horizonte
    const P=[], C_=[];
    for(const it of itens){ const n=Math.min(30,Math.round(it.h*it.w/(110+(it.r-R0)/40)));
      for(let k=0;k<n;k++){ const lado=Math.floor(rnd()*4), a=it.rot+lado*Math.PI/2, meia=(lado%2?it.d:it.w)/2+.6, ao=(rnd()-.5)*(lado%2?it.w:it.d);
        P.push(it.x+Math.sin(a)*meia+Math.cos(a)*ao,it.y0+2+rnd()*(it.h-3),it.z+Math.cos(a)*meia-Math.sin(a)*ao);
        const quente=rnd()<.75, f=Math.max(.25,1-(it.r-R0)/9000); C_.push(f,(quente?.82:.95)*f,(quente?.5:1)*f); } }
    for(let k=0;k<70000&&P.length<3*42000;k++){
      const th=rnd()*Math.PI*2, r=Math.sqrt(R0*R0+rnd()*(Math.pow(R1*.92,2)-R0*R0)), [x,z]=AZ(th,r);
      if(!urbano(x,z)) continue;
      P.push(x,h(x,z)+4,z); const f=Math.max(.28,1-r/R1*.75), quente=rnd()<.8; C_.push(f,(quente?.78:.92)*f,(quente?.45:.95)*f);
    }
    const gl=new THREE.BufferGeometry(); gl.setAttribute("position",new THREE.Float32BufferAttribute(P,3)); gl.setAttribute("color",new THREE.Float32BufferAttribute(C_,3));
    const luzes=new THREE.Points(gl,new THREE.PointsMaterial({size:1.7,sizeAttenuation:false,vertexColors:true,transparent:true,opacity:.9,fog:false,depthWrite:false}));
    luzes.raycast=()=>{}; grupo.add(luzes);
    partes={matChao,matCid,luzes};
    noite(noiteH);
  }
  function noite(v){
    noiteH=v; if(!partes) return;
    partes.matChao.color.set(v?0x2b3150:0xffffff);
    partes.matCid.color.set(v?0x2a3150:0xffffff); partes.matCid.emissive.set(v?0x0c1024:0x000000);
    partes.luzes.visible=v;
  }
  entornoP.then(r=>{ if(!r) return; EM=r[0].relevo; EZ=new Int16Array(r[1]); construir(); });
  return {noite,h,get pronto(){ return !!partes; }};
})();

// ---------- céu: degradê (e estrelas à noite) ----------
const ceuMat=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,fog:false,
  uniforms:{alto:{value:new THREE.Color(0x8db6e6)},horiz:{value:new THREE.Color(0xe4ecf6)}},
  vertexShader:"varying float vY; void main(){ vY=normalize(position).y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }",
  fragmentShader:"uniform vec3 alto; uniform vec3 horiz; varying float vY; void main(){ gl_FragColor=vec4(mix(horiz,alto,pow(clamp(vY,0.,1.),.55)),1.); }"});
const ceuMesh=new THREE.Mesh(new THREE.SphereGeometry(6000,32,16),ceuMat);   // acompanha a câmera (ver laço) ceuMesh.renderOrder=-1; scene.add(ceuMesh);
const estrelas=(()=>{
  const P=[]; let sd=3; const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;
  for(let i=0;i<1400;i++){ const a=rnd()*Math.PI*2, e=Math.asin(.08+rnd()*.92); P.push(Math.cos(a)*Math.cos(e)*5500,Math.sin(e)*5500,Math.sin(a)*Math.cos(e)*5500); }
  const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.Float32BufferAttribute(P,3));
  const pt=new THREE.Points(g,new THREE.PointsMaterial({color:0xdfe6ff,size:1.6,sizeAttenuation:false,fog:false,transparent:true,opacity:.85}));
  pt.visible=false; scene.add(pt); return pt;
})();

// ---------- postes: pontos de luz quente ao longo das ruas (só aparecem à noite) ----------
const postes=(()=>{
  const P=[];
  for(const r of B.ruas.filter(r=>VIAS.has(r.k))){ const c=caminho(r);
    for(let d=12;d<c.L;d+=32){ const [x,z,a]=ponto(c,d), o=r.w/2+1.2, lado=(Math.floor(d/32)%2)?1:-1;
      const px=x+Math.cos(a)*o*lado, pz=z-Math.sin(a)*o*lado; P.push(px,hZ(px,pz)+7,pz); } }
  const c=document.createElement("canvas"); c.width=c.height=64; const g=c.getContext("2d");
  const gr=g.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,"rgba(255,236,190,1)"); gr.addColorStop(.25,"rgba(255,200,120,.55)"); gr.addColorStop(1,"rgba(255,180,90,0)");
  g.fillStyle=gr; g.fillRect(0,0,64,64);
  const geo=new THREE.BufferGeometry(); geo.setAttribute("position",new THREE.Float32BufferAttribute(P,3));
  const pt=new THREE.Points(geo,new THREE.PointsMaterial({map:new THREE.CanvasTexture(c),size:22,sizeAttenuation:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
  pt.visible=false; scene.add(pt); return pt;
})();

// ---------- carros andando nas avenidas ----------
const carros=(()=>{
  const vias=todasRuas.filter(r=>["trunk","primary","secondary","tertiary","trunk_link","primary_link"].includes(r.k)).map(caminho).filter(c=>c.L>60);
  if(!vias.length) return null;
  const pesoTotal=vias.reduce((a,c)=>a+c.L,0);
  const sorteia=()=>{ let t=Math.random()*pesoTotal; for(const c of vias){ t-=c.L; if(t<=0) return c; } return vias[0]; };
  const N=Math.min(MODESTO?140:320,Math.round(pesoTotal/90));
  const corpo=mergeGeometries([new THREE.BoxGeometry(1.8,1,4.2).translate(0,.75,0),new THREE.BoxGeometry(1.6,.7,2.2).translate(0,1.55,-.2)]);
  const mCorpo=new THREE.InstancedMesh(corpo,new THREE.MeshLambertMaterial(),N);
  const farol=new THREE.InstancedMesh(new THREE.BoxGeometry(1.5,.25,.1).translate(0,.85,2.12),new THREE.MeshBasicMaterial({color:0xfff2c4}),N);
  const lanterna=new THREE.InstancedMesh(new THREE.BoxGeometry(1.5,.25,.1).translate(0,.85,-2.12),new THREE.MeshBasicMaterial({color:0xff3b30}),N);
  const CORES=[0xf4f4f2,0x2b2f38,0xb8bcc4,0x9a1f2b,0x2c4f8f,0xf1f1ee,0x5a5f66,0xe0b23a,0xffffff,0x3d6b4e];
  const cor=new THREE.Color(), lista=[];
  for(let i=0;i<N;i++){
    const c=sorteia(); lista.push({c,d:Math.random()*c.L,v:(9+Math.random()*7)*(Math.random()<.5?1:-1)});
    mCorpo.setColorAt(i,cor.set(CORES[i%CORES.length]));
  }
  scene.add(mCorpo,farol,lanterna);
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), um=new THREE.Vector3(1,1,1), eixo=new THREE.Vector3(0,1,0), pos=new THREE.Vector3();
  function passo(dt){
    lista.forEach((k,i)=>{
      k.d+=k.v*dt*Math.max(.12,k.f??1);
      if(k.d<0||k.d>k.c.L){ k.c=sorteia(); k.v=Math.abs(k.v)*(Math.random()<.5?1:-1); k.d=k.v>0?0:k.c.L; }
      const [x,z,a]=ponto(k.c,k.d), ida=k.v>0, faixa=Math.min(3.2,k.c.r.w/4);
      const ox=Math.cos(a)*faixa*(ida?1:-1), oz=-Math.sin(a)*faixa*(ida?1:-1);   // mão direita
      pos.set(x+ox,0,z+oz); pos.y=hZ(pos.x,pos.z)+.25; k.f=nivelEm?nivelEm(pos.x,pos.z):1;
      q.setFromAxisAngle(eixo,a+(ida?0:Math.PI));
      m.compose(pos,q,um); mCorpo.setMatrixAt(i,m); farol.setMatrixAt(i,m); lanterna.setMatrixAt(i,m);
    });
    mCorpo.instanceMatrix.needsUpdate=farol.instanceMatrix.needsUpdate=lanterna.instanceMatrix.needsUpdate=true;
  }
  passo(0);
  return {passo,farol,lanterna};
})();
// ---------- nomes de rua: aparecem quando a câmera chega perto ----------
const nomesRua=(()=>{
  const porNome=new Map();
  for(const r of B.ruas){ if(!r.n||!VIAS.has(r.k)) continue; const c=caminho(r); if(c.L<50) continue;
    const [x,z,a]=ponto(c,c.L/2); (porNome.get(r.n)||porNome.set(r.n,[]).get(r.n)).push({x,z,a,L:c.L}); }
  const itens=[];
  for(const [n,ts] of porNome){
    const escolhidos=[];   // até 3 rótulos por rua, nos trechos mais longos e a pelo menos 180 m um do outro
    for(const t of ts.sort((a,b)=>b.L-a.L)){ if(escolhidos.length<3&&escolhidos.every(e=>Math.hypot(e.x-t.x,e.z-t.z)>180)) escolhidos.push(t); }
    for(const t of escolhidos){
    const el=document.createElement("div"); el.className="nomeRua"; el.textContent=n; el.hidden=true; palco.appendChild(el);
    itens.push({el,pos:new THREE.Vector3(t.x,hZ(t.x,t.z)+2,t.z),a:t.a});
  } }
  return itens;
})();
const semMovimento=matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- árvores (instanciadas): copa redonda, copa alta e ipês floridos ----------
// plantaArvores(lista x/norte, onde, semente): também usada pelos chunks do anel (semente = deslocamento do índice)
const ARV_TIPOS=[new THREE.IcosahedronGeometry(2.6,0), new THREE.ConeGeometry(2.2,6,6).translate(0,1.2,0), new THREE.DodecahedronGeometry(2.4,0).scale(1.25,.8,1.25)];
const ARV_TRONCO=new THREE.CylinderGeometry(.25,.32,2.4,5);
const ARV_MATS=ARV_TIPOS.map(()=>new THREE.MeshLambertMaterial({flatShading:true})), ARV_MAT_TRONCO=new THREE.MeshLambertMaterial({color:0x8a6a4f});
function plantaArvores(A,onde=scene,s0=0,comTronco=true){
  const n=A.length/2, out=[];
  if(!n) return out;
  const tipos=ARV_TIPOS, tronco=ARV_TRONCO, mats=ARV_MATS;
  const grupos=tipos.map(()=>[]);
  for(let i=0;i<n;i++){ const r=hash(i+s0,2971); grupos[r<.62?0:r<.82?2:1].push(i); }
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), s=new THREE.Vector3(), cor=new THREE.Color();
  const mTronco=new THREE.InstancedMesh(tronco,ARV_MAT_TRONCO,n);
  grupos.forEach((ids,t)=>{
    if(!ids.length) return;
    const mc=new THREE.InstancedMesh(tipos[t],mats[t],ids.length);
    ids.forEach((i0,j)=>{
      const i=i0+s0, x=A[2*i0], z=-A[2*i0+1], k=.75+((i*7919)%100)/180, h0=hZ(x,z);
      q.setFromAxisAngle(new THREE.Vector3(0,1,0),i);
      mc.setMatrixAt(j,m.compose(new THREE.Vector3(x,h0+2.4+2.2*k,z),q,s.set(k,k*1.1,k)));
      const ipe=hash(i,613);   // ~7% ipê rosa, ~4% ipê amarelo
      if(t===2&&ipe<.22) cor.set(0xe58fb5); else if(t===2&&ipe<.36) cor.set(0xf2c94c);
      else cor.setHSL(.27+((i*31)%10)/220,.36+((i*13)%10)/60,.36+((i*17)%10)/90);
      mc.setColorAt(j,cor);
    });
    mc.castShadow=true; onde.add(mc); out.push(mc);
  });
  if(!comTronco){ mTronco.dispose(); return out; }   // anel: de longe o tronco nem aparece e custaria um desenho a mais por chunk
  for(let i=0;i<n;i++){ const x=A[2*i], z=-A[2*i+1]; mTronco.setMatrixAt(i,m.compose(new THREE.Vector3(x,hZ(x,z)+1.2,z),q.identity(),s.set(1,1,1))); }
  mTronco.castShadow=true; onde.add(mTronco); out.push(mTronco);
  return out;
}
plantaArvores(B.arvores);

// ---------- pontos de interesse do OpenStreetMap (pois.json), como bolinhas coloridas ----------
const lugaresGrupo=new THREE.Group(); scene.add(lugaresGrupo);
const sprites=[];
let NOME_CAT={}, COR={};
const icone=(cor)=>{
  const c=document.createElement("canvas"); c.width=c.height=64; const g=c.getContext("2d");
  g.beginPath(); g.arc(32,32,24,0,Math.PI*2); g.fillStyle="#fff"; g.fill();
  g.beginPath(); g.arc(32,32,18,0,Math.PI*2); g.fillStyle=cor; g.fill();
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
};
// altura do telhado sob cada lugar (grade de 40 m para achar o prédio)
const grade=new Map();
predios.forEach((b,i)=>{ const x=b.p[0], y=b.p[1]; const k=`${Math.floor(x/40)},${Math.floor(y/40)}`; (grade.get(k)||grade.set(k,[]).get(k)).push(i); });
function alturaEm(x,y){
  const gx=Math.floor(x/40), gy=Math.floor(y/40);
  for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(const i of grade.get(`${gx+dx},${gy+dy}`)||[])
    if(dentroDe(x,y,predios[i].p)) return predios[i].base+predios[i].h;
  return hAt(x,y);
}
if(A){
  COR=Object.fromEntries(A.cats.map(([k,,,c])=>[k,c])); NOME_CAT=Object.fromEntries(A.cats.map(([k,pt,en])=>[k,[pt,en]]));
  const tex={};
  for(const p of A.lugares){
    if(Math.hypot(p.x,p.y)>B.meta.raio_m+300) continue;
    const s=new THREE.Sprite(new THREE.SpriteMaterial({map:tex[p.c]||(tex[p.c]=icone(COR[p.c])),depthTest:true,sizeAttenuation:false}));
    s.scale.set(.022,.022,1); s.position.set(p.x,alturaEm(p.x,p.y)+5,-p.y); s.userData={lugar:p}; s.renderOrder=2;
    lugaresGrupo.add(s); sprites.push(s);
  }
}
const DESLIGADAS=new Set(A?.desligadas||[]);
const ativas=new Set(A?A.cats.map(c=>c[0]).filter(k=>sprites.some(s=>s.userData.lugar.c===k)&&!DESLIGADAS.has(k)):[]);
try{ const salvo=JSON.parse(localStorage.getItem("bairro3d-cats")); if(Array.isArray(salvo)){ ativas.clear(); salvo.forEach(k=>ativas.add(k)); } }catch(e){}
function aplicarCats(){
  for(const s of sprites) s.visible=lugaresGrupo.visible&&ativas.has(s.userData.lugar.c);
  const chips=document.getElementById("chips");
  chips.innerHTML=A?A.cats.filter(([k])=>sprites.some(s=>s.userData.lugar.c===k)).map(([k,pt,en,c])=>
    `<button type="button" data-k="${k}" aria-pressed="${ativas.has(k)}"><i style="background:${c}"></i>${L(esc(pt),esc(en))} <small>${sprites.filter(s=>s.userData.lugar.c===k).length}</small></button>`).join("")
    :`<p>${L("Não consegui carregar os lugares.","Could not load the places.")}</p>`;
  try{ localStorage.setItem("bairro3d-cats",JSON.stringify([...ativas])); }catch(e){}
}
document.getElementById("chips").addEventListener("click",e=>{
  const b=e.target.closest("button[data-k]"); if(!b) return;
  ativas.has(b.dataset.k)?ativas.delete(b.dataset.k):ativas.add(b.dataset.k); aplicarCats();
});
aplicarCats();
const btLugares=document.getElementById("btLugares");
btLugares.onclick=()=>{ lugaresGrupo.visible=!lugaresGrupo.visible; btLugares.setAttribute("aria-pressed",lugaresGrupo.visible); aplicarCats(); };
if(!A){ btLugares.hidden=true; document.getElementById("cartaoLugares").hidden=true; }

// ---------- câmeras: em volta do centro do config ----------
const C=new THREE.Vector3(0,0,0);
const CAMS=[
  [["Visão geral","Overview"],()=>[new THREE.Vector3(C.x-420,520,C.z+600),C.clone().setY(20)]],
  [["Rasante","Low angle"],()=>[new THREE.Vector3(C.x+230,70,C.z+260),C.clone().setY(30)]],
  [["De cima","Top down"],()=>[new THREE.Vector3(C.x+1,1500,C.z+120),C.clone()]],
  [["Bairro todo","Whole area"],()=>[new THREE.Vector3(C.x-1900,2300,C.z+2700),C.clone()]],
];
let anim=null;
function irPara(i){
  let [pos,alvo]=CAMS[i][1]();
  if(camera.aspect<1&&i<2) pos=alvo.clone().add(pos.clone().sub(alvo).multiplyScalar(Math.min(1.8,1.15/camera.aspect)));   // tela em pé: afasta para caber
  pos.y=Math.max(pos.y,hZ(pos.x,pos.z)+15);   // nunca dentro do morro
  anim={t0:performance.now(),dur:1100,p0:camera.position.clone(),a0:controls.target.clone(),p1:pos,a1:alvo};
  document.querySelectorAll("#cams button").forEach((b,j)=>b.setAttribute("aria-pressed",j===i));
}
document.getElementById("cams").innerHTML=CAMS.map(([[pt,en]],i)=>`<button type="button" data-i="${i}" aria-pressed="false">${L(pt,en)}</button>`).join("");
document.getElementById("cams").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b) irPara(+b.dataset.i); });
controls.addEventListener("start",()=>{ anim=null; document.querySelectorAll("#cams button").forEach(b=>b.setAttribute("aria-pressed",false)); });
function voarPara(pos,alvo){
  anim={t0:performance.now(),dur:1400,p0:camera.position.clone(),a0:controls.target.clone(),p1:pos,a1:alvo};
  document.querySelectorAll("#cams button").forEach(b=>b.setAttribute("aria-pressed",false));
}

// ---------- dia / noite ----------
const btNoite=document.getElementById("btNoite");
let noiteAtual=false, ortoNoite=null;   // ortoNoite: a foto aérea (criada mais abaixo) escurece junto
function modo(noite){
  noiteAtual=noite; btNoite.setAttribute("aria-pressed",noite); palco.classList.toggle("noite",noite);
  const ceu=new THREE.Color(noite?0x0d1430:0xdfe8f3);
  scene.background=ceu; scene.fog=new THREE.Fog(ceu,noite?700:900,noite?2000:2600); palco.style.background=ceu.getStyle();
  ceuMat.uniforms.alto.value.set(noite?0x03061a:0x8db6e6); ceuMat.uniforms.horiz.value.set(noite?0x1a2350:0xe4ecf6);
  scene.fog.color.set(noite?0x141c40:0xe4ecf6);
  estrelas.visible=noite; postes.visible=noite; matPasseio.color.set(noite?0x30364f:0xdcd8cf);
  hemi.intensity=noite?.35:1.6; hemi.color.set(noite?0x8ea0ff:0xffffff); hemi.groundColor.set(noite?0x1a1f38:0xb9c2cf);
  sol.intensity=noite?.25:2.2; preench.intensity=noite?.12:.7; sol.color.set(noite?0x9fb0ff:0xfff3e0);
  matJan.forEach((m,e)=>{ m.map=noite?null:TEX[e].dia; m.emissiveIntensity=noite?1:0; m.needsUpdate=true; });
  // paredes lisas e telhados também ganham um brilho próprio fraco, senão somem no escuro
  matLisa.emissive.set(noite?0x2a3050:0x000000); matTel.emissive.set(noite?0x161a30:0x000000);
  matAresta.color.set(noite?0x9aa3d8:0x5c6678); matAresta.opacity=noite?.45:.55;
  matRua.color.set(noite?0x3a4158:0x9aa1ad); matCalcada.color.set(noite?0x2c3248:0xd8d4cb);
  chao.material.color.set(noite?0x252b47:0xffffff);   // multiplica as cores do terreno
  sombraJa();
  ortoNoite?.(noite);
  horizonte.noite(noite);
  matCurva.color.set(noite?0x9aa6e0:0x8a6f55); matMestra.color.set(noite?0xb4bdf0:0x7a5d43);
  matTrilho.color.set(noite?0x4a4258:0x7d6f66);
  try{ localStorage.setItem("bairro3d-noite",noite?"1":"0"); }catch(e){}
}
btNoite.onclick=()=>modo(btNoite.getAttribute("aria-pressed")!=="true");
let noite0=false;
try{ const s_=localStorage.getItem("bairro3d-noite"); if(s_!==null) noite0=s_==="1"; }catch(e){}
modo(noite0);

// ---------- sol de verdade: posição por data e hora (sombra dos prédios e do relevo) ----------
// Posição do sol: fórmulas do SunCalc (precisão de ~1°, de sobra para sombra). São Paulo = UTC−3, sem horário de verão.
function posicaoSol(data,lat,lon){
  const rad=Math.PI/180, d=data.valueOf()/864e5-.5+2440588-2451545, e=rad*23.4397;
  const M=rad*(357.5291+.98560028*d), L_=M+rad*(1.9148*Math.sin(M)+.02*Math.sin(2*M)+.0003*Math.sin(3*M))+rad*102.9372+Math.PI;
  const dec=Math.asin(Math.sin(e)*Math.sin(L_)), ra=Math.atan2(Math.sin(L_)*Math.cos(e),Math.cos(L_));
  const H=rad*(280.16+360.9856235*d)+rad*lon-ra, f=rad*lat;
  const alt=Math.asin(Math.sin(f)*Math.sin(dec)+Math.cos(f)*Math.cos(dec)*Math.cos(H));
  const az=Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(f)-Math.tan(dec)*Math.cos(f))+Math.PI;   // a partir do norte, sentido horário
  return {alt,az};
}
const dirSol=({alt,az})=>new THREE.Vector3(Math.sin(az)*Math.cos(alt),Math.sin(alt),-Math.cos(az)*Math.cos(alt));   // cena: x leste, z −norte
const horaSP=(dia,min)=>new Date(Date.UTC(dia.getFullYear(),dia.getMonth(),dia.getDate(),3,0)+min*6e4);
const RUMOS=[["norte","north"],["nordeste","northeast"],["leste","east"],["sudeste","southeast"],["sul","south"],["sudoeste","southwest"],["oeste","west"],["noroeste","northwest"]];
const btSol=document.getElementById("btSol"), cartaoSol=document.getElementById("cartaoSol");
const solHora=document.getElementById("solHora"), solDia=document.getElementById("solDia"), solTxt=document.getElementById("solTxt"), solPlay=document.getElementById("solPlay");
const hhmm=m=>`${Math.floor(m/60)}h${String(Math.round(m%60)).padStart(2,"0")}`;
function opcoesDia(){ const v=solDia.value||"hoje";
  solDia.innerHTML=[["hoje",T("Hoje","Today")],["03-20",T("Equinócio (20/mar)","Equinox (Mar 20)")],["06-21",T("Inverno (21/jun)","Winter solstice (Jun 21)")],["12-21",T("Verão (21/dez)","Summer solstice (Dec 21)")]]
    .map(([k,t])=>`<option value="${k}">${t}</option>`).join(""); solDia.value=v; }
opcoesDia(); aoTrocarIdioma.push(opcoesDia);
function diaSol(){ const v=solDia.value, a=new Date(); if(v==="hoje") return a; const [mm,dd]=v.split("-").map(Number); return new Date(a.getFullYear(),mm-1,dd); }
let solLigado=false, solAnim=null;
function solAplica(){
  sombraJa();
  const dia=diaSol(), m=+solHora.value, s=posicaoSol(horaSP(dia,m),B.meta.origem.lat,B.meta.origem.lon), d=dirSol(s);
  const acima=s.alt>0, k=Math.max(0,Math.min(1,s.alt/(25*Math.PI/180)));
  const foco=controls.target.clone().setY(0);
  sol.position.copy(foco).addScaledVector(d.y>.02?d:d.clone().setY(.02).normalize(),900); sol.target.position.copy(foco); sol.target.updateMatrixWorld();
  sol.intensity=acima?.6+1.6*k:.05; sol.color.set(0xffa35c).lerp(new THREE.Color(0xfff3e0),k);
  hemi.intensity=acima?.7+.9*k:.45; preench.intensity=acima?.25+.45*k:.1;
  const r=RUMOS[Math.round(s.az*180/Math.PI/45)%8], g=Math.round(s.alt*180/Math.PI);
  solTxt.innerHTML=`${hhmm(m)} · `+(acima?L(`sol a ${g}° de altura, vindo do ${r[0]}`,`sun ${g}° above the horizon, from the ${r[1]}`):L("sol abaixo do horizonte","sun below the horizon"));
}
function solLiga(on){
  solLigado=on; btSol.setAttribute("aria-pressed",on); cartaoSol.hidden=!on;
  if(on){ fechaCartoes("sol"); if(noiteAtual) modo(false); const a=new Date(); if(solDia.value==="hoje") solHora.value=Math.min(1170,Math.max(330,a.getHours()*60+a.getMinutes())); solAplica(); }
  else{ solPara(); sol.position.set(-260,420,-180); sol.target.position.set(0,0,0); sol.target.updateMatrixWorld(); modo(noiteAtual); }
}
function solPara(){ solAnim=null; solPlay.textContent="▶"; solPlay.setAttribute("aria-label",T("Animar o dia","Animate the day")); }
btSol.onclick=()=>solLiga(!solLigado);
document.getElementById("solFechar").onclick=()=>solLiga(false);
solHora.oninput=()=>{ solPara(); solAplica(); };
solDia.onchange=()=>solAplica();
solPlay.onclick=()=>{ if(solAnim){ solPara(); return; } if(+solHora.value>=1170) solHora.value=330; solAnim={t:performance.now()}; solPlay.textContent="❚❚"; solPlay.setAttribute("aria-label",T("Pausar","Pause")); };
btNoite.addEventListener("click",()=>{ if(solLigado&&noiteAtual) solLiga(false); });
function solQuadro(t){
  if(!solLigado||!solAnim) return;
  const dt=t-solAnim.t; solAnim.t=t; solHora.value=Math.min(1170,+solHora.value+dt*.06); if(+solHora.value>=1170) solPara(); solAplica();
}
// um cartão aberto por vez sobre a maquete (sol, zonas, camadas, preço)
const fechadores={};
function fechaCartoes(exceto){ for(const [k,f] of Object.entries(fechadores)) if(k!==exceto) f(); }
fechadores.sol=()=>{ if(solLigado) solLiga(false); };

// ---------- zoneamento: zonas pintadas no chão + lotes que podem virar prédio + alvarás de HIS/HMP (zonas.json) ----------
const ZONA_INFO={
  ZEU:{c:"#e5484d",n:L("Eixo de transformação (ZEU)","Transit corridor (ZEU)"),t:L("perto de metrô e corredores: prédios altos, sem limite de altura","near metro and bus corridors: tall buildings, no height limit")},
  ZC:{c:"#f2994a",n:L("Centralidade (ZC)","Centrality (ZC)"),t:L("comércio e moradia, prédios de até 48 m","shops and homes, buildings up to 48 m")},
  ZM:{c:"#1fa596",n:L("Mista (ZM)","Mixed use (ZM)"),t:L("bairro misto, prédios de até 28 m","mixed neighbourhood, buildings up to 28 m")},
  ZEIS:{c:"#8e6bd8",n:L("Interesse social (ZEIS)","Social housing (ZEIS)"),t:L("reservada para moradia popular; permite prédios altos","reserved for affordable housing; tall buildings allowed")},
};
// película: textura desenhada num canvas, numa cópia do chão alguns metros acima (as casas não escondem a cor; as torres atravessam)
const EXT_PEL=Math.max(ZN?.raio||0,CM?.raio||0,B.meta.raio_m)+50;   // películas cobrem o raio das camadas 
const tracar=(g,p,px=g.px)=>{ g.beginPath(); for(let i=0;i<p.length;i+=2){ const [a,b]=px(p[i],p[i+1]); i?g.lineTo(a,b):g.moveTo(a,b); } g.closePath(); };
let geoPel=null;
function pelicula(desenha,acima=10,W=MODESTO?2048:4096){
  const cv=document.createElement("canvas"); cv.width=cv.height=W; const g=cv.getContext("2d");
  const px=(x,y)=>[(x+EXT_PEL)/(2*EXT_PEL)*W,(EXT_PEL-y)/(2*EXT_PEL)*W]; g.px=px;
  desenha(g,px,W);
  g.clearRect(0,0,W,3); g.clearRect(0,W-3,W,3); g.clearRect(0,0,3,W); g.clearRect(W-3,0,3,W);   // borda transparente (a textura estica a borda)
  const tex=new THREE.CanvasTexture(cv); tex.colorSpace=THREE.SRGBColorSpace; tex.anisotropy=8;
  tex.onUpdate=()=>{ cv.width=cv.height=1; };   // depois de ir para a placa de vídeo, o canvas grande (até 64 MB) sai da memória
  if(!geoPel){ const P=chao.geometry.attributes.position, ix=chao.geometry.index.array, uv=new Float32Array(P.count*2), pos=new Float32Array(P.count*3), idx=[];
    for(let i=0;i<P.count;i++){ pos[3*i]=P.getX(i); pos[3*i+1]=P.getY(i); pos[3*i+2]=P.getZ(i); uv[2*i]=(P.getX(i)+EXT_PEL)/(2*EXT_PEL); uv[2*i+1]=1-(P.getZ(i)+EXT_PEL)/(2*EXT_PEL); }
    for(let t=0;t<ix.length;t+=3){ const a=ix[t]; if(Math.abs(P.getX(a))<EXT_PEL&&Math.abs(P.getZ(a))<EXT_PEL) idx.push(ix[t],ix[t+1],ix[t+2]); }
    geoPel=new THREE.BufferGeometry(); geoPel.setAttribute("position",new THREE.BufferAttribute(pos,3)); geoPel.setAttribute("uv",new THREE.BufferAttribute(uv,2)); geoPel.setIndex(idx); }
  const me=new THREE.Mesh(geoPel,new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
  me.position.y=acima; me.renderOrder=1; me.raycast=()=>{}; return me;
}
const zonaDe=z=>ZONA_INFO[z]||(z?.startsWith("ZEIS")?ZONA_INFO.ZEIS:{c:"#9aa3b5",n:z||"?",t:""});
const grupoZonas=new THREE.Group(); grupoZonas.visible=false; scene.add(grupoZonas);
const fantasmas=[];   // malhas clicáveis (lotes com potencial e alvarás)
let zonasMontadas=false;
function montaZonas(){   // só no primeiro clique em Zonas: a película e ~1.100 volumes não pesam na abertura
  if(zonasMontadas||!ZN) return; zonasMontadas=true;
  // zonas pintadas numa película sobre o chão (2048 px ≈ 1 m por pixel)
  grupoZonas.add(pelicula(g=>{ for(const z of ZN.zonas){ const c=zonaDe(z.z).c; tracar(g,z.p); g.fillStyle=c+"66"; g.fill(); g.strokeStyle=c+"ee"; g.lineWidth=3; g.stroke(); } }));
  // volumes fantasmas: projeção típica da torre no meio do lote, com a altura estimada
  const fazer=(lista,cor,tipo,etapa)=>{
    const gs=[], donos=[], linhas=[], base0=[];
    lista.forEach((l,i)=>{
      const pts=[]; for(let j=0;j<l.p.length;j+=2) pts.push([l.p[j],l.p[j+1]]);
      const cx=pts.reduce((a,p)=>a+p[0],0)/pts.length, cy=pts.reduce((a,p)=>a+p[1],0)/pts.length;
      const k=Math.min(1,Math.sqrt((l.proj||l.a*.5)/Math.max(1,l.a)))*.92, q=pts.map(([x,y])=>[cx+(x-cx)*k,cy+(y-cy)*k]);
      const base=Math.min(...q.map(([x,y])=>hZ(x,-y))), alto=Math.max(l.h,(l.h0||0)+3);
      const geo=new THREE.ExtrudeGeometry(new THREE.Shape(q.map(([x,y])=>new THREE.Vector2(x,y))),{depth:alto,bevelEnabled:false}).rotateX(-Math.PI/2).translate(0,base,0);
      gs.push(geo); for(let t=0;t<geo.attributes.position.count/3;t++) donos.push(i);
      for(let t=0;t<geo.attributes.position.count;t++) base0.push(base);
      for(let j=0;j<q.length;j++){ const [x1,y1]=q[j],[x2,y2]=q[(j+1)%q.length];
        linhas.push(x1,base+alto,-y1, x2,base+alto,-y2, x1,base,-y1, x1,base+alto,-y1); }
    });
    if(!gs.length) return;
    const me=new THREE.Mesh(mergeGeometries(gs),new THREE.MeshLambertMaterial({color:cor,transparent:true,opacity:.38,depthWrite:false,side:THREE.DoubleSide}));
    me.renderOrder=2; me.userData={zonaTipo:tipo,donos,lista}; grupoZonas.add(me); fantasmas.push(me);
    const lg=new THREE.BufferGeometry(); lg.setAttribute("position",new THREE.Float32BufferAttribute(linhas,3));
    const ls=new THREE.LineSegments(lg,new THREE.LineBasicMaterial({color:cor,transparent:true,opacity:.9})); grupoZonas.add(ls);
    // skyline: o mesmo volume, sólido, que "cresce" do chão (cada vértice sobe a partir da base do seu prédio)
    const gSol=me.geometry.clone(); gSol.setAttribute("base0",new THREE.Float32BufferAttribute(base0,1));
    const mat=new THREE.MeshLambertMaterial({color:etapa===1?0xe4ded2:etapa===2?0xc9cff5:0xf3d3b4}), u={value:0};
    mat.onBeforeCompile=sh=>{ sh.uniforms.cresce=u;
      sh.vertexShader=sh.vertexShader.replace("#include <common>","#include <common>\nattribute float base0; uniform float cresce;")
        .replace("#include <begin_vertex>","#include <begin_vertex>\ntransformed.y=base0+(transformed.y-base0)*max(cresce,.002);"); };
    mat.customProgramCacheKey=()=>"cresce";
    const sol_=new THREE.Mesh(gSol,mat); sol_.castShadow=sol_.receiveShadow=true; sol_.visible=false; sol_.frustumCulled=false;
    sol_.userData={zonaTipo:tipo,donos,lista,cresce:u,etapa,fantasma:[me,ls]}; grupoFuturo.add(sol_); futuros.push(sol_);
  };
  fazer(ZN.potenciais,0xf2994a,"potencial",3);
  fazer(ZN.alvaras,0x4352d8,"alvara",2);
  const novas=(ZN.obras||[]).filter(o=>o.tipo==="nova"&&o.h>(o.h0||0)+3);   // só o que sobe acima do que o LiDAR já via
  for(const [his,cor] of [[true,0x4352d8],[false,0x178a5a]]){
    fazer(novas.filter(o=>!!o.his===his&&o.concl),cor,"obra",1);
    fazer(novas.filter(o=>!!o.his===his&&!o.concl),cor,"obra",2); }
}
// ---------- skyline: 2020 (maquete) → hoje (obras concluídas) → + aprovadas → + lotes que podem virar prédio ----------
const grupoFuturo=new THREE.Group(); scene.add(grupoFuturo);
const futuros=[];
let etapaFut=0, animFut=null;
function skyline(e){
  if(e>0) montaZonas();
  etapaFut=e; document.querySelectorAll("#segFuturo button").forEach(b=>b.setAttribute("aria-pressed",+b.dataset.e===e));
  const n=k=>futuros.filter(m=>m.userData.etapa===k).reduce((a,m)=>a+m.userData.lista.length,0);
  document.getElementById("futTxt").innerHTML=[
    L("A maquete mostra o que está no mapa. Veja o que subiu nos últimos anos e o que vem por aí.","The model shows what is on the map. See what went up in recent years and what is coming."),
    L(`${n(1)} prédios novos concluídos desde 2020 (certificado de conclusão no Aprova Digital), mais altos que o que a maquete tem no lote.`,`${n(1)} new buildings completed since 2020 (completion certificate in Aprova Digital), taller than what the model has on the lot.`),
    L(`+ ${n(2)} prédios com alvará ainda em obra ou só aprovados, com a altura do projeto (ou estimada).`,`+ ${n(2)} permitted buildings still under construction or only approved, at the design height (or an estimate).`),
    L(`+ ${n(3)} lotes que podem virar prédio pelo zoneamento: o cenário máximo, não uma previsão.`,`+ ${n(3)} lots that zoning would allow to become towers: the maximum scenario, not a forecast.`)][e];
  animFut={t0:performance.now(),de:futuros.map(m=>m.userData.cresce.value)};
  for(const m of futuros) if(m.userData.etapa<=e) m.visible=true;
}
function futuroQuadro(agora){
  if(!animFut) return;
  const t=Math.min(1,(agora-animFut.t0)/(semMovimento?1:1100)), k=1-(1-t)**3;
  futuros.forEach((m,i)=>{ const alvo=m.userData.etapa<=etapaFut?1:0; m.userData.cresce.value=animFut.de[i]+(alvo-animFut.de[i])*k;
    for(const f of m.userData.fantasma) f.visible=!(alvo&&t>=1);
    if(t>=1&&!alvo) m.visible=false; });
  if(t>=1) animFut=null;
}
document.getElementById("segFuturo").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b) skyline(+b.dataset.e); });
const btZonas=document.getElementById("btZonas"), cartaoZonas=document.getElementById("cartaoZonas");
if(!ZN) btZonas.hidden=true;
else cartaoZonas.querySelector(".leg").innerHTML=["ZEU","ZC","ZM","ZEIS"].map(z=>{ const i=ZONA_INFO[z]; return `<div class="lz"><i style="background:${i.c}"></i><b>${i.n}</b><span>${i.t}</span></div>`; }).join("")+
  `<div class="lz"><i class="fant" style="border-color:#f2994a;background:#f2994a55"></i><b>${L("Pode virar prédio","Could become a tower")} (${ZN.potenciais.length})</b><span>${L("lote grande, ainda baixo, em zona que permite subir; altura estimada","large lot, still low-rise, in a zone that allows height; estimated height")}</span></div>`+
  `<div class="lz"><i class="fant" style="border-color:#4352d8;background:#4352d855"></i><b>${L("Moradia popular aprovada ou pedida","Affordable housing approved or requested")} (${ZN.alvaras.length+(ZN.obras||[]).filter(o=>o.tipo==="nova"&&o.his).length})</b><span>${L("prédios HIS/HMP com alvará desde 2020; podem já estar prontos","HIS/HMP buildings permitted since 2020; some may be finished")}</span></div>`+
  `<div class="lz"><i class="fant" style="border-color:#178a5a;background:#178a5a55"></i><b>${L("Outras obras com alvará","Other permitted construction")} (${(ZN.obras||[]).filter(o=>o.tipo==="nova"&&!o.his).length})</b><span>${L("edificação nova pedida desde 2020 (Aprova Digital), acima de ~250 m²","new building requested since 2020 (Aprova Digital), over ~250 m²")}</span></div>`;
function zonasLiga(on){
  if(on) montaZonas();
  grupoZonas.visible=on; btZonas.setAttribute("aria-pressed",on); cartaoZonas.hidden=!on;
  if(on) fechaCartoes("zonas");
}
fechadores.zonas=()=>{ if(grupoZonas.visible) zonasLiga(false); };
btZonas.onclick=()=>zonasLiga(!grupoZonas.visible);
document.getElementById("zonasFechar").onclick=()=>zonasLiga(false);
const dataBR=d=>d?L(d.split("-").reverse().join("/"),d):"";
const centroDeLista=p=>{ const n=p.length/2; let x=0,y=0; for(let i=0;i<p.length;i+=2){ x+=p[i]; y+=p[i+1]; } return [x/n,y/n]; };
const linkCentro=()=>`<a class="sec" href="#" data-centro>${L("Voltar ao "+esc(NOME),"Back to "+esc(NOME))}</a>`;
function infoObra(l){
  const zi=zonaDe(l.z), [cx,cy]=centroDeLista(l.p), d=Math.hypot(cx,cy);
  const sit=l.concl?L(`concluída (certificado de ${dataBR(l.concl)})`,`completed (certificate of ${dataBR(l.concl)})`):l.def?L(`alvará deferido em ${dataBR(l.def)}`,`permit granted on ${dataBR(l.def)}`):L(`pedido protocolado em ${dataBR(l.d)}`,`request filed on ${dataBR(l.d)}`);
  info.innerHTML=`<p class="tit">${l.his?L("Prédio de moradia popular","Affordable housing building"):L("Obra nova com alvará","Permitted new building")}</p>
    <p class="sub">${esc((l.e||T("Endereço não informado","Address not given")).replace(/\s*\|.*$/,"").replace(/, \d{5}-?\d{3}$/,""))}</p>
    <dl><dt>${L("Situação","Status")}</dt><dd>${sit}</dd>
    <dt>${L("Projeto","Design")}</dt><dd>${l.ac?`${num(l.ac)} m² ${L("construídos","built")}`:L("área não informada","area not given")}${l.pav?` · ${l.pav} ${L("andares","floors")}`:""}${l.u?` · ${l.u} ${L("unidades","units")}`:""}</dd>
    <dt>${L("Zona","Zone")}</dt><dd><span style="color:${zi.c};font-weight:500">${zi.n}</span> · ${L("terreno de","lot of")} ${num(l.a)} m²</dd>
    <dt>${L("Hoje","Today")}</dt><dd>${l.h0>=3?L(`construção de ~${Math.round(l.h0)} m`,`~${Math.round(l.h0)} m structure`):L("sem construção relevante","nothing significant built")} (${L("maquete","model")})</dd>
    <dt>${L("Altura","Height")}</dt><dd>~${Math.round(l.h)} m${l.pav?"":` ${L("(estimada)","(estimated)")}`}</dd>
    <dt>${L("Distância","Distance")}</dt><dd>${dist(d)} ${L("do "+esc(NOME),"from "+esc(NOME))}</dd></dl>
    <p class="mt">${esc(l.assunto||"")}. ${L("Fonte: Aprova Digital (SMUL, dados abertos)","Source: Aprova Digital (São Paulo planning department, open data)")}${l.def?L(" e GeoSampa (HIS/HMP)"," and GeoSampa (HIS/HMP)"):""}. ${L("Altura: andares × 3 m + térreo.","Height: floors × 3 m + ground floor.")}</p>
    ${linkCentro()}`;
}
function infoFantasma(tipo,l){
  if(tipo==="obra") return infoObra(l);
  const zi=zonaDe(l.z), par=ZN.param[l.z]||ZN.param[l.z?.replace(/-\d$/,"")]||null, [cx,cy]=centroDeLista(l.p), d=Math.hypot(cx,cy);
  info.innerHTML=`<p class="tit">${tipo==="alvara"?L("Alvará de moradia popular","Affordable housing permit"):L("Lote que pode virar prédio","Lot that could become a tower")}</p>
    <p class="sub">${tipo==="potencial"?L("Imóvel particular: endereço omitido","Private property: address withheld"):esc(l.e||T("Endereço não informado","Address not given"))}</p>
    <dl><dt>${L("Zona","Zone")}</dt><dd><span style="color:${zi.c};font-weight:500">${zi.n}</span>${par?` · ${L("coeficiente até","floor area ratio up to")} ${par.ca}×${par.gab?` · ${L("até","up to")} ${par.gab} m`:` · ${L("sem limite de altura","no height limit")}`}`:""}</dd>
    <dt>${L("Terreno","Lot")}</dt><dd>${num(l.a)} m²</dd>
    <dt>${L("Hoje","Today")}</dt><dd>${l.h0>=3?L(`construção de ~${Math.round(l.h0)} m`,`~${Math.round(l.h0)} m structure`):L("sem construção relevante","nothing significant built")} (${L("maquete","model")})</dd>
    ${tipo==="alvara"?`<dt>${L("Aprovado","Approved")}</dt><dd>${num(l.ac)} m²${l.u?` · ${l.u} ${L("unidades","units")}`:""}${l.def?` · ${L("deferido em","granted on")} ${dataBR(l.def)}`:` · ${L("em análise","under review")}`}</dd>`:""}
    <dt>${L("Altura estimada","Estimated height")}</dt><dd>~${Math.round(l.h)} m (~${Math.max(1,Math.round((l.h-4)/3))} ${L("andares","floors")})</dd>
    <dt>${L("Distância","Distance")}</dt><dd>${dist(d)} ${L("do "+esc(NOME),"from "+esc(NOME))}</dd></dl>
    <p class="mt">${tipo==="alvara"?L("Altura estimada pela área aprovada sobre uma projeção típica.","Height estimated from the approved floor area over a typical footprint."):L("Estimativa grosseira: usa o coeficiente máximo da zona numa torre que ocupa até metade do lote (máx. ~650 m²). Recuos, outorga onerosa e o mercado mudam o resultado.","Rough estimate: the zone's maximum floor area ratio in a tower covering up to half the lot (max ~650 m²). Setbacks, development fees and the market change the outcome.")}</p>
    ${linkCentro()}`;
}

const ICONE_EST='<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l-2-3M15 21l2-3"/>';
// ---------- camadas: alagamento, transporte e crimes (camadas.json) ----------
const grupoCam={alag:new THREE.Group(),transp:new THREE.Group(),crime:new THREE.Group()};
for(const g of Object.values(grupoCam)){ g.visible=false; scene.add(g); }
const clicaveisCam=[];   // pontos de ônibus
const pilulasCam=[];     // estações projetadas (pílulas HTML; o laço posiciona)
const cartaoCam=document.getElementById("cartaoCam"), btCam=document.getElementById("btCam");
const pontoNoPoligono=(x,y,p)=>{ let d=false; for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){ const xi=p[i],yi=p[i+1],xj=p[j],yj=p[j+1];
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi) d=!d; } return d; };
const distPoligono=(x,y,p)=>{ if(pontoNoPoligono(x,y,p)) return 0; let m=1e9;
  for(let i=0,j=p.length-2;i<p.length;j=i,i+=2){ const ax=p[j],ay=p[j+1],bx=p[i],by=p[i+1],dx=bx-ax,dy=by-ay,L=dx*dx+dy*dy||1;
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/L)); m=Math.min(m,Math.hypot(x-ax-t*dx,y-ay-t*dy)); } return m; };
let cartaoCamAberto=false;
const DO=L("do "+esc(NOME),"from "+esc(NOME));
if(CM){
  // ----- alagamento: película com as manchas (chuva forte de 25 anos por cima da de 100 anos) -----
  const AZ=[["#9fd0f7",.42],["#4d9fe6",.6],["#1d5fc4",.78]];
  const TR=CM.transporte, montado={};
  const monta={alag:()=>grupoCam.alag.add(pelicula(g=>{
    for(const m of CM.alagamento.manchas.slice().sort((a,b)=>b.tr-a.tr||a.f-b.f)){
      const [c,a]=m.tr===100?["#b9dcf7",.32]:AZ[m.f];
      g.fillStyle=c; g.globalAlpha=a; tracar(g,m.p); g.fill(); }
    g.globalAlpha=1; g.setLineDash([10,7]); g.lineWidth=3; g.strokeStyle="#d23b3b";
    for(const r of CM.alagamento.risco){ tracar(g,r.p); g.stroke(); }
    g.setLineDash([]);
  })),
  // ----- transporte -----
  transp:()=>{
  if(TR.faixas.length){ const me=new THREE.Mesh(fita(TR.faixas.map(f=>({w:2.4,p:f.p})),1.05),new THREE.MeshBasicMaterial({color:0xe5484d,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-6}));
    me.raycast=()=>{}; grupoCam.transp.add(me); }
  for(const l of TR.linhas.filter(l=>l.proj)){   // linhas projetadas: faixa tracejada na cor da linha
    const pts=[]; for(let i=0;i<l.p.length;i+=2) pts.push([l.p[i],l.p[i+1]]);
    const tr=[];
    for(let i=0;i<pts.length-1;i++){ const [x1,y1]=pts[i],[x2,y2]=pts[i+1], Lg=Math.hypot(x2-x1,y2-y1);
      for(let q=0;q<Lg;q+=24){ const q2=Math.min(Lg,q+14); tr.push({w:7,p:[x1+(x2-x1)*q/Lg,y1+(y2-y1)*q/Lg,x1+(x2-x1)*q2/Lg,y1+(y2-y1)*q2/Lg]}); } }
    if(!tr.length) continue;
    const me=new THREE.Mesh(fita(tr,1.15),new THREE.MeshBasicMaterial({color:new THREE.Color(l.cor),transparent:true,opacity:.85,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-6}));
    me.raycast=()=>{}; grupoCam.transp.add(me);
  }
  { // pontos de ônibus: haste + placa azul (uma malha só; o clique acha o ponto pelo triângulo)
    const gs=[], donos=[];
    TR.pontos.forEach((p,i)=>{ const y0=hZ(p.x,-p.y);
      const g=mergeGeometries([new THREE.CylinderGeometry(.45,.45,9,6).translate(0,4.5,0),new THREE.CylinderGeometry(2.6,2.6,.6,16).rotateX(Math.PI/2).translate(0,9.6,0),new THREE.CylinderGeometry(5,5,.4,16).translate(0,.3,0)]).translate(p.x,y0,-p.y);
      gs.push(g); for(let t=0;t<g.index.count/3;t++) donos.push(i); });
    if(gs.length){ const me=new THREE.Mesh(mergeGeometries(gs),new THREE.MeshLambertMaterial({color:0x2563eb}));
      me.userData={camOnibus:true,donos}; grupoCam.transp.add(me); clicaveisCam.push(me); }
  }
  for(const e of TR.estacoes.filter(e=>e.proj&&Math.hypot(e.x,e.y)<2600)){   // estações projetadas (as em operação já estão no mapa)
    const y0=hZ(e.x,-e.y), el=document.createElement("button"); el.type="button"; el.className="lugar proj"; el.style.setProperty("--c",e.cor);
    el.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONE_EST}</svg>${esc(e.n)} <small>${L("projetada","planned")}</small>`;
    el.setAttribute("aria-label",T(`Estação ${e.n}, linha ${e.linha}, projetada`,`${e.n} station, line ${e.linha}, planned`)); el.style.display="none"; palco.appendChild(el);
    const q={e,el,pos:new THREE.Vector3(e.x,y0+14,-e.y)}; pilulasCam.push(q);
    el.onclick=()=>{ const m=Math.hypot(e.x,e.y);
      abrirBalao(q.pos,`<b>${L("Estação","Station")} ${esc(e.n)}</b><div class="tipo">${L("Linha","Line")} ${esc(e.linha)} · ${L("projetada","planned")} · ${dist(m)} ${DO}</div><p>${L("Estação planejada; ainda sem obra nem data confirmadas. Fonte: GeoSampa.","Planned station; no construction or date confirmed yet. Source: GeoSampa.")}</p>`); };
    const marco=new THREE.Mesh(new THREE.CylinderGeometry(9,9,1.2,24),new THREE.MeshBasicMaterial({color:new THREE.Color(e.cor),transparent:true,opacity:.75}));
    marco.position.set(e.x,y0+.8,-e.y); marco.raycast=()=>{}; grupoCam.transp.add(marco);
  }
  }};
  // ----- crimes: grade agregada (células de 100 m com mínimo de ocorrências), pintada numa película -----
  const CR=CM.crimes;
  const CAT={todos:["Todos","All"],roubo:["Roubos","Robbery"],furto:["Furtos","Theft"],veiculo:["Veículos","Vehicles"],agressao:["Agressões","Assault"],transito:["Trânsito","Traffic"]};
  let catCrime="todos", malhaCrime=null;
  const valor=c=>catCrime==="todos"?c.n:(c[catCrime]||0);
  const desenhaCrimes=()=>{
    if(!CR) return;
    if(malhaCrime){ grupoCam.crime.remove(malhaCrime); malhaCrime.material.map.dispose(); malhaCrime.material.dispose(); }
    const vs=CR.celulas.map(valor).filter(v=>v>0).sort((a,b)=>a-b), topo=vs.length?vs[Math.floor(vs.length*.95)]:1;
    malhaCrime=pelicula((g,px,W)=>{
      const lado=CR.celula_m*W/(2*EXT_PEL);
      for(const c of CR.celulas){ const v=valor(c); if(!v) continue;
        const t=Math.min(1,Math.log1p(v)/Math.log1p(topo)), [a,b]=px(c.x,c.y);
        g.fillStyle=`rgba(${Math.round(250-30*t)},${Math.round(210*(1-t)+30*t)},${Math.round(70*(1-t)+40*t)},${(.12+.6*t*t).toFixed(2)})`;
        g.fillRect(a-lado/2+1,b-lado/2+1,lado-2,lado-2); }
    },10,MODESTO?1024:2048);
    grupoCam.crime.add(malhaCrime);
  };
  // ----- cartão: três camadas com resumo, sempre em relação ao centro -----
  const resumoAlag=(()=>{ let m=1e9, prof=null;
    for(const x of CM.alagamento.manchas){ const d=distPoligono(0,0,x.p); if(d<m){ m=d; prof=x; } }
    if(!CM.alagamento.manchas.length) return L("Não há manchas de inundação mapeadas no raio.","No mapped flood zones within the radius.");
    return m<1?L(`O centro (${esc(NOME)}) fica <b>dentro</b> de uma mancha de inundação.`,`The centre (${esc(NOME)}) lies <b>inside</b> a flood zone.`)
      :L(`O centro fica fora das manchas; a mais próxima está a ${dist(m)}${prof?` (chuva de ${prof.tr} anos)`:""}.`,`The centre is outside the flood zones; the nearest is ${dist(m)} away${prof?` (${prof.tr}-year storm)`:""}.`); })();
  const resumoTransp=(()=>{ const ps=TR.pontos.map(p=>[Math.hypot(p.x,p.y),p]).sort((a,b)=>a[0]-b[0]);
    const linhas=new Set(ps.filter(([d])=>d<400).flatMap(([,p])=>p.l.map(c=>c.replace(/-\d+$/,""))));
    const est=TR.estacoes.map(e=>[Math.hypot(e.x,e.y),e]).sort((a,b)=>a[0]-b[0]);
    const op=est.find(([,e])=>!e.proj), pj=est.find(([,e])=>e.proj);
    return (ps.length?L(`Ponto de ônibus mais perto do centro: ${dist(ps[0][0])}; ${linhas.size} linhas a até 400 m.`,`Nearest bus stop to the centre: ${dist(ps[0][0])}; ${linhas.size} lines within 400 m.`)+"<br>":"")+
      (op?L(`Metrô/trem em operação mais perto: <b>${esc(op[1].n)}</b> (${esc(op[1].linha)}), ${dist(op[0])}.`,`Nearest metro/rail station: <b>${esc(op[1].n)}</b> (${esc(op[1].linha)}), ${dist(op[0])}.`)+"<br>":"")+
      (pj?L(`Projetada mais perto: <b>${esc(pj[1].n)}</b> (Linha ${esc(pj[1].linha)}), ${dist(pj[0])}.`,`Nearest planned station: <b>${esc(pj[1].n)}</b> (line ${esc(pj[1].linha)}), ${dist(pj[0])}.`):""); })();
  const resumoCrime=()=>{
    if(!CR) return L("Sem dados.","No data.");
    const cel=CR.celulas, tot=cel.reduce((a,c)=>a+valor(c),0), perto=cel.filter(c=>Math.hypot(c.x,c.y)<300).reduce((a,c)=>a+valor(c),0);
    const dens=tot/(Math.PI*(CM.raio||B.meta.raio_m)**2)*Math.PI*300*300;
    const P=[["madrugada (0–6h)","night (0–6h)"],["manhã (6–12h)","morning (6–12h)"],["tarde (12–18h)","afternoon (12–18h)"],["noite (18–24h)","evening (18–24h)"]];
    const porP=[0,0,0,0]; for(const c of cel) if(catCrime==="todos") c.per.forEach((v,i)=>porP[i]+=v);
    const pico=porP.indexOf(Math.max(...porP)), f=d=>d.split("-").reverse().slice(1).join("/");
    return L(`<b>${perto}</b> ocorrências a até 300 m do centro em 12 meses (${f(CR.ini)} a ${f(CR.fim)}); a média da área toda para o mesmo tamanho é ${Math.round(dens)}.`,
             `<b>${perto}</b> reports within 300 m of the centre in 12 months (${f(CR.ini)} to ${f(CR.fim)}); the average for an area that size across the map is ${Math.round(dens)}.`)+
      (catCrime==="todos"&&Math.max(...porP)>0?" "+L(`Período mais comum: ${P[pico][0]}.`,`Most common time: ${P[pico][1]}.`):"");
  };
  const chips=Object.entries(CAT).map(([k,[pt,en]])=>`<button type="button" class="chip${k==="todos"?" on":""}" data-cat="${k}">${L(pt,en)}</button>`).join("");
  cartaoCam.querySelector(".corpo").innerHTML=`
    <label class="camada"><input type="checkbox" data-cam="alag"><b>${L("Alagamento","Flooding")}</b></label>
    <div class="det" data-det="alag"><div class="leg-l"><span><i style="background:#1d5fc4"></i>${L("chuva forte (25 anos), mais de 80 cm","heavy storm (25-year), over 80 cm")}</span><span><i style="background:#4d9fe6"></i>30–80 cm</span><span><i style="background:#9fd0f7"></i>${L("até 30 cm","up to 30 cm")}</span><span><i style="background:#b9dcf7;opacity:.7"></i>${L("chuva extrema (100 anos)","extreme storm (100-year)")}</span><span><i class="tr" style="border-color:#d23b3b"></i>${L("área de risco","risk area")}</span></div><p>${resumoAlag}</p></div>
    <label class="camada"><input type="checkbox" data-cam="transp"><b>${L("Transporte","Transit")}</b></label>
    <div class="det" data-det="transp"><div class="leg-l"><span><i style="background:#2563eb;border-radius:50%"></i>${L("ponto de ônibus (toque para ver as linhas)","bus stop (tap to see lines)")}</span><span><i style="background:#e5484d"></i>${L("faixa exclusiva de ônibus","bus lane")}</span><span><i class="tr" style="border-color:#a74a95"></i>${L("metrô projetado","planned metro")}</span></div><p>${resumoTransp}</p></div>
    ${CR?`<label class="camada"><input type="checkbox" data-cam="crime"><b>${L("Ocorrências policiais","Reported crime")}</b></label>
    <div class="det" data-det="crime"><div class="chips">${chips}</div><p class="rc"></p><p class="mt">${L(`Boletins de ocorrência com local (SSP-SP), contados em células de ${CR.celula_m} m; células com menos de ${CR.minimo} ocorrências não aparecem. Nenhum boletim ou endereço individual é publicado. Crimes em residência e de violência sexual não têm o local divulgado pela SSP.`,
      `Police reports with a location (SSP-SP), counted in ${CR.celula_m} m cells; cells with fewer than ${CR.minimo} reports are hidden. No individual report or address is published. Crimes at homes and sexual violence have no published location.`)}</p></div>`:""}`;
  const atualizaCrime=()=>{ desenhaCrimes(); cartaoCam.querySelector(".rc").innerHTML=resumoCrime(); };
  cartaoCam.querySelectorAll("[data-cat]").forEach(b=>b.onclick=()=>{ catCrime=b.dataset.cat; cartaoCam.querySelectorAll("[data-cat]").forEach(x=>x.classList.toggle("on",x===b)); atualizaCrime(); });
  cartaoCam.querySelectorAll("[data-cam]").forEach(c=>c.onchange=()=>{ const k=c.dataset.cam;
    if(c.checked&&monta[k]&&!montado[k]){ montado[k]=1; monta[k](); }
    grupoCam[k].visible=c.checked;
    cartaoCam.querySelector(`[data-det="${k}"]`).classList.toggle("aberto",c.checked);
    if(k==="crime"&&c.checked&&!malhaCrime) atualizaCrime();
    btCam.setAttribute("aria-pressed",Object.values(grupoCam).some(g=>g.visible)); });
} else btCam.hidden=true;
function camLiga(on){ cartaoCamAberto=on; cartaoCam.hidden=!on; btCam.setAttribute("aria-expanded",on);
  if(on){ fechaCartoes("cam");
    const alg=cartaoCam.querySelector("[data-cam]:checked"); if(!alg){ const c=cartaoCam.querySelector('[data-cam="alag"]'); if(c){ c.checked=true; c.onchange(); } } } }
fechadores.cam=()=>{ if(cartaoCamAberto) camLiga(false); };
btCam.onclick=()=>camLiga(!cartaoCamAberto);
document.getElementById("camFechar").onclick=()=>camLiga(false);
function infoOnibus(p){
  const m=Math.hypot(p.x,p.y), ls=[...new Set(p.l.map(c=>c.replace(/-\d+$/,"")))];
  info.innerHTML=`<p class="tit">${L("Ponto de ônibus","Bus stop")}</p><p class="sub">${esc(p.n||T("Sem nome","Unnamed"))}</p>
    <dl><dt>${L("Distância","Distance")}</dt><dd>${dist(m)} ${DO} · ${aPeTxt(m)}</dd><dt>${L("Linhas","Lines")}</dt><dd>${ls.length?ls.map(esc).join(" · "):L("não identificadas","not identified")}</dd></dl>
    <p class="mt">${L("Linhas da SPTrans cujo trajeto passa a até 25 m do ponto (GeoSampa).","SPTrans lines whose route passes within 25 m of the stop (GeoSampa).")}</p>
    ${linkCentro()}`;
}
{ // filtros: abre/fecha o painel; o contador mostra quantas camadas estão ligadas
  const bt=document.getElementById("btFiltros"), pn=document.getElementById("filtros"), n=document.getElementById("nFiltros");
  const camadas=[...pn.querySelectorAll(".fgrid")[0].querySelectorAll("button")];
  const abrir=v=>{ pn.hidden=!v; bt.setAttribute("aria-expanded",v); };
  bt.addEventListener("click",e=>{ e.stopPropagation(); abrir(pn.hidden); });
  // os que abrem um cartão próprio (Zonas, Camadas, Sol, Rua) fecham o painel para não cobrir o cartão
  pn.addEventListener("click",e=>{ const b=e.target.closest("button"); if(b&&["btZonas","btCam","btSol","btRua","btPreco"].includes(b.id)) abrir(false); });
  document.addEventListener("pointerdown",e=>{ if(!pn.hidden&&!pn.contains(e.target)&&!bt.contains(e.target)) abrir(false); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&!pn.hidden) abrir(false); });
  const conta=()=>{ const k=camadas.filter(b=>!b.hidden&&b.getAttribute("aria-pressed")==="true").length; n.textContent=k||""; };
  new MutationObserver(conta).observe(pn,{subtree:true,attributes:true,attributeFilter:["aria-pressed","hidden"]}); conta(); }
{ // os cartões ficam logo acima da barra de botões (que pode ter duas linhas)
  const ac=document.querySelector(".flut.acoes"), pal=document.getElementById("palco");
  new ResizeObserver(()=>pal.style.setProperty("--acoesH",ac.offsetHeight+"px")).observe(ac); }
function camadasQuadro(){
  if(!pilulasCam.length) return;
  const ver=grupoCam.transp.visible;
  for(const q of pilulasCam){
    let ok=ver; if(ok){ const w=q.pos.clone().project(camera); ok=w.z<1&&Math.abs(w.x)<1.02&&Math.abs(w.y)<1.02&&(1-w.y)/2*palco.clientHeight>60;
      if(ok){ q.el.style.left=`${(w.x+1)/2*palco.clientWidth}px`; q.el.style.top=`${(1-w.y)/2*palco.clientHeight}px`; } }
    q.el.style.display=ok?"":"none";
  }
}
const btRelevo=document.getElementById("btRelevo");
function relevo(v){ curvas.visible=v; btRelevo.setAttribute("aria-pressed",v); try{ localStorage.setItem("bairro3d-relevo",v?"1":"0"); }catch(e){} }
btRelevo.onclick=()=>relevo(!curvas.visible);
{ let v=true; try{ v=localStorage.getItem("bairro3d-relevo")!=="0"; }catch(e){} relevo(v&&!!RM); if(!RM) btRelevo.hidden=true; }

// ---------- foto aérea: Ortofoto 2020 da Prefeitura em blocos sobre o relevo; só baixa (~6 MB) quando ligada ----------
const btOrto=document.getElementById("btOrto");
const orto=(()=>{
  const g=new THREE.Group(); g.visible=false; scene.add(g);
  const mat=[]; let carregado=null, faltam=0;   // faltam: blocos ainda sem foto (com todos prontos, o chão de baixo some)
  ortoNoite=v=>mat.forEach(m=>m.color.set(v?0x4a5070:0xffffff));
  function carrega(){
    if(carregado) return carregado;
    return carregado=pegar("orto.json").then(M=>{
      if(!M){ btOrto.hidden=true; return; }
      const P=20, R=chao.userData.R, n=Math.round(M.passo_m/P), an=renderer.capabilities.getMaxAnisotropy(), carr=new THREE.TextureLoader();
      for(let j=0;j<M.blocos;j++) for(let i=0;i<M.blocos;i++){
        const x0=M.min+i*M.passo_m, y0=M.min+j*M.passo_m, pos=[], uv=[], idx=[];
        for(let b=0;b<=n;b++) for(let a=0;a<=n;a++){ const x=x0+a*P, y=y0+b*P; pos.push(x,hAt(x,y)+.04,-y); uv.push(a/n,b/n); }
        for(let b=0;b<n;b++) for(let a=0;a<n;a++){
          if(Math.hypot(x0+(a+.5)*P,y0+(b+.5)*P)>R) continue;     // mesmo recorte redondo do chão
          const k=b*(n+1)+a; idx.push(k,k+1,k+n+1, k+1,k+n+2,k+n+1);
        }
        if(!idx.length) continue;
        const geo=new THREE.BufferGeometry();
        geo.setAttribute("position",new THREE.Float32BufferAttribute(pos,3)); geo.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));
        geo.setIndex(idx); geo.computeVertexNormals();
        const m=new THREE.MeshLambertMaterial({color:noiteAtual?0x4a5070:0xffffff,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
        faltam++; carr.load(`${DADOS}orto/${i}_${j}.webp`,t=>{ t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=an; m.map=t; m.needsUpdate=true; if(--faltam===0) chao.visible=!g.visible; });
        mat.push(m); const me=new THREE.Mesh(geo,m); me.receiveShadow=true; g.add(me);
      }
    });
  }
  return {
    liga(v){ g.visible=v; ruasMesh.visible=calcMesh.visible=!v; chao.visible=!v||!carregado||faltam>0; btOrto.setAttribute("aria-pressed",v); if(v) carrega(); },
    get visivel(){ return g.visible; },
  };
})();
btOrto.onclick=()=>{ orto.liga(!orto.visivel); try{ localStorage.setItem("bairro3d-orto",orto.visivel?"1":"0"); }catch(e){} };
{ let v=false; try{ v=localStorage.getItem("bairro3d-orto")==="1"; }catch(e){} if(v) orto.liga(true); }
const btGirar=document.getElementById("btGirar");
btGirar.onclick=()=>{ controls.autoRotate=!controls.autoRotate; btGirar.setAttribute("aria-pressed",controls.autoRotate);
  if(controls.autoRotate&&controls.target.distanceTo(C)>60) controls.target.copy(C).setY(25); };

// ---------- painel de informações embaixo da maquete ----------
const info=document.getElementById("info");
const mediana=a=>{ const q=[...a].sort((x,y)=>x-y), m=q.length>>1; return q.length%2?q[m]:(q[m-1]+q[m])/2; };
// ITBI agregado: quadras (contorno, n, medianas) e a série do bairro por semestre
const QUADRAS=IT?.quadras||[];
for(const q of QUADRAS){ let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9; for(let i=0;i<q.p.length;i+=2){ x0=Math.min(x0,q.p[i]); x1=Math.max(x1,q.p[i]); y0=Math.min(y0,q.p[i+1]); y1=Math.max(y1,q.p[i+1]); } q.bb=[x0,x1,y0,y1]; }
const quadraEm=(x,y)=>QUADRAS.find(q=>x>=q.bb[0]&&x<=q.bb[1]&&y>=q.bb[2]&&y<=q.bb[3]&&dentroDe(x,y,q.p))||null;
function graficoSerie(serie,anos){
  if(!serie||serie.length<3) return "";
  const k=s=>+s.slice(0,4)*2+(+s.slice(5)-1), pts=serie.map(([s,m,n])=>[k(s),m,n]);
  const pr=Object.entries(anos||{}).map(([a,[m,n]])=>[+a*2+.5,m,n]);
  const k0=pts[0][0], k1=Math.max(pts[pts.length-1][0],...pr.map(p=>p[0])), vs=[...pts.map(p=>p[1]),...pr.map(p=>p[1])];
  const lo=Math.min(...vs)*.92, hi=Math.max(...vs)*1.05, W=300,H=118,Lm=34,Rm=8,Tm=8,Bm=20;
  const X=v=>Lm+(v-k0)/Math.max(1,k1-k0)*(W-Lm-Rm), Y=v=>Tm+(hi-v)/(hi-lo)*(H-Tm-Bm);
  const passo=hi-lo>12000?4000:hi-lo>6000?2000:1000, linhasY=[]; for(let v=Math.ceil(lo/passo)*passo; v<hi; v+=passo) linhasY.push(v);
  const as=[]; for(let a=Math.ceil(k0/2); a*2<=k1; a++) as.push(a);
  const var_=(pts[pts.length-1][1]/pts[0][1]-1)*100;
  return `<div class="graf"><p class="gt">${L("R$/m² de apartamentos, mediana por semestre","Apartment price per m² (R$), half-year median")}</p>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${T("Mediana do R$/m² por semestre","Median R$/m² per half-year")}">
      ${linhasY.map(v=>`<line x1="${Lm}" x2="${W-Rm}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="gl"/><text x="${Lm-4}" y="${(Y(v)+3.5).toFixed(1)}" text-anchor="end">${v/1000}k</text>`).join("")}
      ${as.filter((a,i)=>as.length<8||i%2===0).map(a=>`<text x="${X(a*2).toFixed(1)}" y="${H-5}" text-anchor="middle">${a}</text>`).join("")}
      <polyline class="gb" points="${pts.map(p=>`${X(p[0]+.5).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}"/>
      ${pts.map(p=>`<circle class="gp" cx="${X(p[0]+.5).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="2.4"><title>${p[0]>>1}/${p[0]%2+1}: ${brl(p[1])}/m² (${p[2]})</title></circle>`).join("")}
      ${pr.map(p=>`<rect x="${(X(p[0])-3).toFixed(1)}" y="${(Y(p[1])-3).toFixed(1)}" width="6" height="6" fill="#b99a5b"><title>${T("Esta quadra","This block")} ${p[0]>>1}: ${brl(p[1])}/m² (${p[2]})</title></rect>`).join("")}
    </svg>
    <p class="mt">${pts[0][0]>>1} → ${pts[pts.length-1][0]>>1}: ${var_>=0?"+":""}${Math.round(var_)}% ${L("(valores nominais, sem descontar a inflação)","(nominal, not adjusted for inflation)")}${pr.length?" · "+L("quadrados dourados: mediana anual desta quadra","gold squares: this block's yearly median"):""}</p></div>`;
}
const NOTA_ITBI=()=>L(`Valor declarado nas guias de ITBI pagas (Prefeitura de São Paulo), às vezes abaixo do mercado. O m² usa a área do IPTU, que inclui parte das áreas comuns. Publicado só por quadra, com pelo menos ${IT?.minimo||5} vendas.`,
  `Price declared on paid ITBI property-transfer tax forms (City of São Paulo), sometimes below market. Area per m² comes from the property-tax record and includes part of the common areas. Shown only per block, with at least ${IT?.minimo||5} sales.`);
function htmlQuadra(q){
  if(!q) return IT?`<p class="mt">${L("Sem vendas suficientes registradas nesta quadra para publicar um preço.","Not enough registered sales on this block to publish a price.")}</p>`:"";
  return `<div class="vendas"><p class="gt"><b>${L("Vendas registradas nesta quadra","Registered sales on this block")}</b></p>
    <dl><dt>${L("Últimos 24 meses","Last 24 months")}</dt><dd>${q.n} ${L("vendas","sales")}</dd>
    ${q.ap?`<dt>${L("Apartamentos","Apartments")}</dt><dd>${brl(q.ap.m2)}/m² (${q.ap.n})</dd>`:""}
    ${q.casa?`<dt>${L("Casas","Houses")}</dt><dd>${brl(q.casa.m2)}/m² (${q.casa.n})</dd>`:""}</dl>
    ${graficoSerie(IT.serie?.anel,q.anos)}</div>`;
}
let nPredios=0, maisAlto=null; for(const b of predios){ if(b.anel) continue; nPredios++; if(!maisAlto||b.h>maisAlto.h) maisAlto=b; }
function infoCentro(){
  const s=IT?.serie?.raio, ult=s?.length?s[s.length-1]:null;
  info.innerHTML=`<p class="tit">${esc(NOME)}</p><p class="sub">${esc(B.meta.regiao||"")}</p>
    <dl><dt>${L("Prédios","Buildings")}</dt><dd>${num(nPredios)} ${L(`num raio de ${B.meta.raio_m} m`,`within ${B.meta.raio_m} m`)}</dd>
    ${maisAlto?`<dt>${L("Mais alto","Tallest")}</dt><dd>${num(maisAlto.h,0)} m${maisAlto.n?` · ${esc(maisAlto.n)}`:""} · ${dist(Math.hypot(maisAlto.cx,maisAlto.cy))} ${L("do centro","from the centre")}</dd>`:""}
    ${RM?`<dt>${L("Altitude","Elevation")}</dt><dd>${altitude(0)} m ${L("no centro","at the centre")}</dd>`:""}
    ${ult?`<dt>${L("Apartamentos","Apartments")}</dt><dd>${brl(ult[1])}/m² ${L(`(mediana de ${ult[2]} vendas no semestre ${ult[0].replace("-","/")}, até ${B.meta.raio_m} m)`,`(median of ${ult[2]} sales in half-year ${ult[0].replace("-","/")}, within ${B.meta.raio_m} m)`)}</dd>`:""}</dl>
    ${graficoSerie(s)}
    ${IT?`<p class="mt">${NOTA_ITBI()}</p>`:""}
    <p class="mt">${L("Toque num prédio, num lugar ou numa camada para ver os detalhes aqui.","Tap a building, a place or a layer to see details here.")}</p>`;
}
function infoPredio(b){
  const and=b.h>=9?` · ~${Math.max(1,Math.round((b.h-3)/3))} ${L("andares","floors")}`:"";
  const [cx,cy]=b.cx!=null?[b.cx,b.cy]:centroDeLista(b.p);
  const fonte=b.l?L("LiDAR 2020","2020 LiDAR"):b.est?L("altura estimada","estimated height"):L("altura do mapa","mapped height");
  info.innerHTML=`<p class="tit">${b.n?esc(b.n):(b.h>=12?L("Prédio","Building"):L("Casa / sobrado","House"))}</p>
    <p class="sub">${num(b.h,1)} m ${L("de altura","tall")}${and} · ${fonte}</p>
    <dl><dt>${L("Distância","Distance")}</dt><dd>${dist(Math.hypot(cx,cy))} ${DO_C}</dd>${RM?`<dt>${L("Terreno","Ground")}</dt><dd>${altitude(b.base)} m ${L("de altitude","above sea level")}</dd>`:""}</dl>
    ${htmlQuadra(quadraEm(cx,cy))}
    ${linkCentro()}`;
}
const DO_C=L("do centro","from the centre");
function infoLugar(p){
  const nm=NOME_CAT[p.c]||["",""];
  info.innerHTML=`<p class="tit">${esc(p.n)}</p><p class="sub">${L(esc(nm[0]),esc(nm[1]))}${p.t?" · "+esc(p.t):""}</p>
    <dl><dt>${L("Distância","Distance")}</dt><dd>${dist(p.m)} ${DO_C} · ${aPeTxt(p.m)}</dd>${p.end?`<dt>${L("Endereço","Address")}</dt><dd>${esc(p.end)}</dd>`:""}</dl>
    <a class="sec" href="${osm(p.x,p.y)}" target="_blank" rel="noopener">${L("Ver no OpenStreetMap","View on OpenStreetMap")}</a><br>
    ${linkCentro()}`;
}
info.addEventListener("click",e=>{ if(e.target.closest("[data-centro]")){ e.preventDefault(); voltarAoCentro(); } });
function voltarAoCentro(){ fecharBalao(); infoCentro(); irPara(0); }
document.getElementById("btCasa").addEventListener("click",voltarAoCentro);

// ---------- camada de preço: quadras pintadas pela mediana do R$/m² (apartamentos; sem eles, casas) ----------
const btPreco=document.getElementById("btPreco"), cartaoPreco=document.getElementById("cartaoPreco");
const RAMPA=["#d3ebe0","#aad2bf","#7db69d","#57997d","#397a60","#235c46","#143e2e"];
let grupoPreco=null;
const precoDe=q=>q.ap?.m2||q.casa?.m2||null;
const cortes=(()=>{ const vs=QUADRAS.map(precoDe).filter(Boolean).sort((a,b)=>a-b); if(vs.length<7) return null;
  return RAMPA.map((_,i)=>vs[Math.min(vs.length-1,Math.floor(vs.length*(i+1)/RAMPA.length))]); })();
const corPreco=v=>RAMPA[Math.max(0,cortes.findIndex(c=>v<=c))];
function precoLiga(on){
  if(on&&!grupoPreco&&cortes){ grupoPreco=new THREE.Group(); scene.add(grupoPreco);
    grupoPreco.add(pelicula(g=>{ for(const q of QUADRAS){ const v=precoDe(q); if(!v) continue; tracar(g,q.p); g.fillStyle=corPreco(v)+"d0"; g.fill(); g.strokeStyle="#ffffffaa"; g.lineWidth=2; g.stroke(); } },12)); }
  if(grupoPreco) grupoPreco.visible=on;
  btPreco.setAttribute("aria-pressed",on); cartaoPreco.hidden=!on;
  if(on) fechaCartoes("preco");
}
fechadores.preco=()=>{ if(btPreco.getAttribute("aria-pressed")==="true") precoLiga(false); };
if(!cortes) btPreco.hidden=true;
else{
  const k=v=>v>=1e4?L(`${String(Math.round(v/100)/10).replace(".",",")} mil`,`${Math.round(v/100)/10}k`):num(v);
  cartaoPreco.querySelector(".corpo").innerHTML=`<div class="rampa">${RAMPA.map(c=>`<i style="background:${c}"></i>`).join("")}</div>
    <div class="rampa-l"><span>R$ ${k(Math.min(...QUADRAS.map(precoDe).filter(Boolean)))}</span><span>R$ ${k(cortes[3])}</span><span>R$ ${k(cortes[6])}/m²</span></div>
    <p class="mt">${L(`${QUADRAS.length} quadras com pelo menos ${IT.minimo} vendas nos últimos 24 meses. Cor = mediana do R$/m² dos apartamentos (ou das casas, se não houver apartamentos).`,`${QUADRAS.length} blocks with at least ${IT.minimo} sales in the last 24 months. Colour = median price per m² of apartments (or houses where there are none).`)}</p>
    ${graficoSerie(IT.serie?.anel)}
    <p class="mt">${NOTA_ITBI()}</p>`;
}
btPreco.onclick=()=>precoLiga(btPreco.getAttribute("aria-pressed")!=="true");
document.getElementById("precoFechar").onclick=()=>precoLiga(false);

// ---------- clique, balão e nome ao passar o mouse ----------
const ray=new THREE.Raycaster(), mouse=new THREE.Vector2();
let baixo=null;
renderer.domElement.addEventListener("pointerdown",e=>{ baixo=[e.clientX,e.clientY]; });
// bolinha mais perto do ponteiro na tela (tolerância maior no toque), desde que não esteja escondida atrás de prédio
const vTmp=new THREE.Vector3(), rOcl=new THREE.Raycaster();
function bolinhaEm(cx,cy,tol){
  const r=renderer.domElement.getBoundingClientRect();
  let melhor=null, dMin=tol;
  for(const s_ of sprites){
    if(!s_.visible) continue;
    vTmp.copy(s_.position).project(camera); if(vTmp.z>1) continue;
    const d=Math.hypot(r.left+(vTmp.x+1)/2*r.width-cx, r.top+(1-vTmp.y)/2*r.height-cy);
    if(d<dMin){ dMin=d; melhor=s_; }
  }
  if(melhor){
    const Ld=camera.position.distanceTo(melhor.position);
    rOcl.set(camera.position,melhor.position.clone().sub(camera.position).normalize()); rOcl.far=Ld-3;
    if(rOcl.intersectObjects([...malhasPredios,chao],false).length) melhor=null;
  }
  return melhor;
}
const balao=document.getElementById("balao");
let balaoEm=null;   // posição 3D a que o balão está preso
function abrirBalao(pos,htm){ balaoEm=pos.clone(); balao.innerHTML=`<button type="button" class="x" aria-label="${T("Fechar","Close")}">×</button>${htm}`; balao.hidden=false; }
function fecharBalao(){ balaoEm=null; balao.hidden=true; }
balao.addEventListener("click",e=>{ if(e.target.closest(".x")) fecharBalao(); });
const marcadores=[];   // pílulas HTML presas a pontos 3D; o laço posiciona
const htmlLugar=p=>{ const nm=NOME_CAT[p.c]||["",""]; return `<b>${esc(p.n)}</b><div class="tipo"><i style="background:${COR[p.c]}"></i>${L(esc(nm[0]),esc(nm[1]))}${p.t?" · "+esc(p.t):""}</div>
  <p>${dist(p.m)} ${DO_C} · ${aPeTxt(p.m)}</p>${p.end?`<p>${esc(p.end)}</p>`:""}`; };
function mostrarLugar(s_){ infoLugar(s_.userData.lugar); abrirBalao(s_.position,htmlLugar(s_.userData.lugar)); }
const nomeLugar=document.getElementById("nomeLugar");
renderer.domElement.addEventListener("pointermove",e=>{
  if(e.buttons||e.pointerType!=="mouse"){ nomeLugar.hidden=true; return; }
  const s_=bolinhaEm(e.clientX,e.clientY,12), r=palco.getBoundingClientRect();
  renderer.domElement.style.cursor=s_?"pointer":"";
  nomeLugar.hidden=!s_;
  if(s_){ nomeLugar.textContent=s_.userData.lugar.n; nomeLugar.style.left=`${e.clientX-r.left}px`; nomeLugar.style.top=`${e.clientY-r.top}px`; }
});
renderer.domElement.addEventListener("pointerleave",()=>{ nomeLugar.hidden=true; });
renderer.domElement.addEventListener("pointerup",e=>{
  if(!baixo||Math.hypot(e.clientX-baixo[0],e.clientY-baixo[1])>(e.pointerType==="touch"?12:6)) return;   // foi arrasto, não clique
  if(rua.ativo&&rua.toque(e)) return;
  if(fotosRua.clique(e)) return;
  if(onibus.clique(e)) return;
  const s_=bolinhaEm(e.clientX,e.clientY,e.pointerType==="touch"?30:16);
  if(s_){ mostrarLugar(s_); return; }
  const r=renderer.domElement.getBoundingClientRect();
  mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
  ray.setFromCamera(mouse,camera);
  const hit=ray.intersectObjects([...(grupoZonas.visible?fantasmas:[]),...futuros.filter(m=>m.visible),...(grupoCam.transp.visible?clicaveisCam:[]),...malhasPredios],false)[0];
  fecharBalao();
  if(!hit) return;
  const o=hit.object;
  if(o.userData.camOnibus){ const p=CM.transporte.pontos[o.userData.donos[hit.faceIndex]]; if(p) infoOnibus(p); }
  else if(o.userData.zonaTipo){ const l=o.userData.lista[o.userData.donos[hit.faceIndex]]; if(l) infoFantasma(o.userData.zonaTipo,l); }
  else if(o.userData.chunk){ const u=o.userData.chunk, b=u.lista[u.donos[hit.faceIndex]-u.s0]; if(b) infoPredio(b); }
  else if(o.userData.tipo){ infoPredio(predios[triDono[o.userData.tipo][hit.faceIndex]]); }
});

// ---------- postos: preço do combustível (postos.json: levantamento da ANP + endereço geocodificado no OSM) ----------
const ICONE_POSTO='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h14M7 8h6"/><path d="M15 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V9l-3-3"/></svg>';
const postos=[];
const btPostos=document.getElementById("btPostos");
let verPostos=false; try{ verPostos=localStorage.getItem("bairro3d-postos")==="1"; }catch(e){}
btPostos.setAttribute("aria-pressed",verPostos);
const reais=v=>v==null?"—":L("R$ "+v.toFixed(2).replace(".",","),"R$ "+v.toFixed(2));
const diaMes=d=>d?L(d.slice(8,10)+"/"+d.slice(5,7),d.slice(5,7)+"/"+d.slice(8,10)):"";
function htmlPosto(p,x,y){
  return `<b>${esc(p.n)}</b><div class="tipo">${esc(p.b||T("Posto","Fuel station"))} · ${dist(p.m)} ${DO_C}</div>
    ${p.g!=null?`<dl class="precos"><dt>${L("Gasolina","Petrol")}</dt><dd>${reais(p.g)}</dd>${p.ga!=null?`<dt>${L("Aditivada","Premium")}</dt><dd>${reais(p.ga)}</dd>`:""}${p.e!=null?`<dt>${L("Etanol","Ethanol")}</dt><dd>${reais(p.e)}</dd>`:""}</dl>
    <p>${L("Coleta da ANP em","ANP survey on")} ${diaMes(p.data)}${p.e&&p.g?` · ${L("etanol","ethanol")} ${Math.round(p.e/p.g*100)}% ${L("da gasolina","of petrol")}`:""}</p>`:`<p>${L("Sem preço recente: a ANP não pesquisou este posto nas últimas 4 semanas.","No recent price: ANP did not survey this station in the last 4 weeks.")}</p>`}
    ${p.end?`<p>${esc(p.end)}</p>`:""}
    <p><a href="${osm(x,y)}" target="_blank" rel="noopener">OpenStreetMap</a></p>`;
}
function irAoPosto(q){
  const alvo=q.pos.clone(), dir=camera.position.clone().sub(controls.target).setY(0).normalize();
  anim={t0:performance.now(),dur:1100,p0:camera.position.clone(),a0:controls.target.clone(),p1:alvo.clone().add(dir.multiplyScalar(260)).setY(alvo.y+200),a1:alvo};
  abrirBalao(q.topo,htmlPosto(q.p,q.pos.x,-q.pos.z));
}
pegar("postos.json").then(D=>{
  if(!D||!D.postos?.length){ btPostos.hidden=true; return; }
  const kx=B.meta.m_por_grau.lon, ky=B.meta.m_por_grau.lat, o=B.meta.origem;
  const gs=D.postos.map(p=>p.g).filter(v=>v!=null), gMin=Math.min(...gs), gMax=Math.max(...gs);
  const cor=g=>g==null?null:g<=gMin+.1?"#16a34a":g>=gMax-.1?"#dc2626":"#d97706";   // mais barato verde, mais caro vermelho
  for(const p of [...D.postos,...(D.sem_preco||[])]){
    const x=(p.lon-o.lon)*kx, y=(p.lat-o.lat)*ky, h0=hZ(x,-y);
    const el=document.createElement("button"); el.type="button";
    el.className="posto"+(p.g!=null?"":" sem"); el.innerHTML=ICONE_POSTO+(p.g!=null?p.g.toFixed(2):"");
    el.setAttribute("aria-label",`${p.n}${p.g!=null?`, ${T("gasolina","petrol")} R$ ${p.g.toFixed(2)}`:""}`);
    if(p.g!=null) el.style.setProperty("--c",cor(p.g));
    el.style.display="none"; palco.appendChild(el);
    const q={p,el,cor:cor(p.g),pos:new THREE.Vector3(x,h0+4,-y),topo:new THREE.Vector3(x,h0+14,-y)};
    el.addEventListener("click",()=>irAoPosto(q));
    postos.push(q);
  }
  const lista=postos.filter(q=>q.p.g!=null).sort((a,b)=>a.p.g-b.p.g||a.p.m-b.p.m);
  document.getElementById("postosLista").innerHTML=lista.map(q=>`<button type="button" data-i="${postos.indexOf(q)}" style="--c:${q.cor}"><i></i><b>${esc(q.p.n)}</b><span>${esc(q.p.b||"")} · ${dist(q.p.m)} · ${diaMes(q.p.data)}</span><em>${reais(q.p.g)}</em></button>`).join("");
  document.getElementById("postosInfo").innerHTML=L(`Gasolina comum, do mais barato ao mais caro. Levantamento da ANP (coleta até ${diaMes(D.coleta_ate)}); outros ${(D.sem_preco||[]).length} postos do raio não foram pesquisados nas últimas 4 semanas.`,
    `Regular petrol, cheapest first. ANP survey (collected up to ${diaMes(D.coleta_ate)}); ${(D.sem_preco||[]).length} other stations in the area were not surveyed in the last 4 weeks.`);
  document.getElementById("postosLista").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b) irAoPosto(postos[+b.dataset.i]); });
  document.getElementById("cartaoPostos").hidden=!verPostos;
});
btPostos.onclick=()=>{ verPostos=!verPostos; btPostos.setAttribute("aria-pressed",verPostos); document.getElementById("cartaoPostos").hidden=!verPostos||!postos.length;
  try{ localStorage.setItem("bairro3d-postos",verPostos?"1":"0"); }catch(e){} };

// ---------- lugares conhecidos, campos e piscinas, estações e trens (entorno.json) ----------
const lugares=[], trens=[];
const COR_LUGAR={parque:"#16a34a",clube:"#2563eb",shopping:"#db2777",estadio:"#ea580c",universidade:"#7c3aed",cultura:"#be185d",mercado:"#b45309",metro:"#e11d2e",trem:"#0e7490"};
const TIPO_LUGAR={parque:["Parque","Park"],clube:["Clube","Club"],shopping:["Shopping","Mall"],estadio:["Estádio","Stadium"],universidade:["Universidade","University"],
  cultura:["Cultura","Culture"],mercado:["Mercado","Market"],metro:["Estação","Station"],trem:["Estação","Station"]};
const ICONE_TREM='<rect x="6" y="3" width="12" height="14" rx="3"/><path d="M6 11h12M9 21l-2-3M15 21l2-3"/>';
const ICONE_LUGAR={parque:'<path d="M12 3l5 7h-3l4 6H6l4-6H7z"/><path d="M12 16v5"/>',clube:'<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>',
  shopping:'<path d="M5 8h14l-1 12H6z"/><path d="M9 8a3 3 0 0 1 6 0"/>',estadio:'<ellipse cx="12" cy="12" rx="9" ry="6"/><ellipse cx="12" cy="12" rx="4" ry="2.5"/>',
  universidade:'<path d="M3 9l9-5 9 5-9 5z"/><path d="M7 11v5c3 2 7 2 10 0v-5"/>',cultura:'<circle cx="12" cy="12" r="8"/><path d="M9 10h.01M15 10h.01M8.5 14.5c2 2 5 2 7 0"/>',
  mercado:'<path d="M4 9h16l-1.5 11h-13z"/><path d="M4 9l2-5h12l2 5"/>',metro:ICONE_TREM,trem:ICONE_TREM};
const tipoL=t=>TIPO_LUGAR[t]||["Lugar","Place"];
function htmlDestaque(l){
  const [pt,en]=tipoL(l.t);
  return `<b>${esc(l.n)}</b><div class="tipo">${L(pt,en)} · ${dist(l.m)} ${DO_C}</div>
    <p><a href="${osm(l.x,l.y)}" target="_blank" rel="noopener">${L("Ver no OpenStreetMap","View on OpenStreetMap")}</a></p>`;
}
function irLugar(q){
  const alvo=q.pos.clone(), dir=camera.position.clone().sub(controls.target).setY(0);
  if(dir.lengthSq()<1) dir.set(0,0,1); dir.normalize();
  const longe=Math.max(360,Math.min(1100,Math.sqrt(q.l.area||0)*1.7));
  voarPara(alvo.clone().add(dir.multiplyScalar(longe)).setY(alvo.y+longe*.8),alvo);
  setTimeout(()=>abrirBalao(q.topo,htmlDestaque(q.l)),1450);
}
function passoTrens(t){
  if(!trens.length) return;
  const tt=semMovimento?40000:t;
  for(const tr of trens){
    const cab=((tt/1000*tr.v+tr.off)%(tr.L+500))-120;   // a frente entra 120 m antes do começo e sai depois do fim
    tr.carros.forEach((m,i)=>{
      let s=cab-i*20.4; if(tr.volta) s=tr.L-s;
      if(s<0||s>tr.L){ m.visible=false; return; }
      let a=0, b=tr.acum.length-1; while(b-a>1){ const k=(a+b)>>1; if(tr.acum[k]<=s) a=k; else b=k; }
      const f=(s-tr.acum[a])/Math.max(.01,tr.acum[b]-tr.acum[a]), [x1,z1]=tr.pts[a], [x2,z2]=tr.pts[b];
      const x=x1+(x2-x1)*f, z=z1+(z2-z1)*f;
      m.position.set(x,hZ(x,z)+.35,z); m.rotation.y=Math.atan2(x2-x1,z2-z1); m.visible=true;
    });
  }
}
entornoP.then(r=>{
  if(!r) return;
  const E=r[0], H=horizonte.h, o=B.meta.origem, kx=B.meta.m_por_grau.lon, ky=B.meta.m_por_grau.lat;
  const centroP=p=>{ let x=0,y=0; for(let i=0;i<p.length;i+=2){ x+=p[i]; y+=p[i+1]; } return [x/(p.length/2),y/(p.length/2)]; };
  const dentro=p=>Math.hypot(...centroP(p))<2540;
  const semZ=m=>{ m.polygonOffset=true; m.polygonOffsetFactor=-2; m.polygonOffsetUnits=-4; return m; };
  const plano=(p,y)=>{
    let g=new THREE.ShapeGeometry(new THREE.Shape(pares(p).map(([x,z])=>new THREE.Vector2(x,-z)))).rotateX(-Math.PI/2).toNonIndexed();
    g=new TessellateModifier(10,5).modify(g); g.deleteAttribute("uv");
    const P=g.attributes.position; for(let i=0;i<P.count;i++) P.setY(i,hZ(P.getX(i),P.getZ(i))+y);
    g.computeVertexNormals(); return g;
  };

  // campos, quadras e piscinas (com as linhas brancas e a borda)
  const CORC={parque:0x9fd38a,futebol:0x5aa84a,quadra:0x4a7fc0,tenis:0xc86a43,areia:0xe3cf98,agua:0x3fb4e6};
  const geos={}, linhas=[];
  for(const c of E.campos){ if(!dentro(c.p)) continue; (geos[c.k]||(geos[c.k]=[])).push(plano(c.p,.34)); if(c.k!=="areia") linhas.push({w:.5,p:c.p}); }
  for(const p of E.piscinas){ if(!dentro(p)) continue; (geos.agua||(geos.agua=[])).push(plano(p,.36)); linhas.push({w:.9,p}); }
  if(linhas.length){ const me=new THREE.Mesh(fita(linhas,.16),semZ(new THREE.MeshLambertMaterial({color:0xf4f6f2,side:THREE.DoubleSide}))); me.raycast=()=>{}; scene.add(me); }

  // lugares: contorno colorido no chão (perto) ou volume simples (shoppings fora da maquete) + pílula clicável
  const contornos={};
  const pilula=(cls,cor,icone,txt,aria)=>{ const el=document.createElement("button"); el.type="button"; el.className="lugar"+(cls?" "+cls:"");
    el.style.setProperty("--c",cor); el.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${icone}</svg>${esc(txt)}`;
    el.setAttribute("aria-label",aria); el.style.display="none"; palco.appendChild(el); return el; };
  const novo=(l,alto,cls)=>{
    const z=-l.y, y0=H(l.x,z); l.lat=o.lat+l.y/ky; l.lon=o.lon+l.x/kx;
    const q={l,pos:new THREE.Vector3(l.x,y0+alto,z),topo:new THREE.Vector3(l.x,y0+alto+8,z),perto:l.m>2600?7000:4600};
    q.el=pilula(cls,COR_LUGAR[l.t]||"#6b7280",ICONE_LUGAR[l.t]||ICONE_LUGAR.cultura,l.n,`${l.n}: ${T(...tipoL(l.t)).toLowerCase()}, ${distT(l.m)}`);
    q.el.addEventListener("click",()=>irLugar(q)); lugares.push(q); marcadores.push(q); return q;
  };
  for(const l of E.lugares){
    for(const p of l.p){
      const fora=l.m>2400;
      (contornos[l.t]||(contornos[l.t]={perto:[],longe:[]}))[fora?"longe":"perto"].push({w:fora?7:3,p});
      if(!fora&&l.t==="parque") (geos.parque||(geos.parque=[])).push(plano(p,.29));   // parque inteiro em verde (campos e piscinas por cima)
      if(fora&&(l.t==="shopping"||l.t==="estadio")){
        const pts=pares(p), base=Math.min(...pts.map(([x,z])=>H(x,z)));
        const g=new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x,z])=>new THREE.Vector2(x,-z))),{depth:l.t==="shopping"?24:12,bevelEnabled:false}).rotateX(-Math.PI/2);
        const me=new THREE.Mesh(g,new THREE.MeshLambertMaterial({color:l.t==="shopping"?0xe9e3ee:0xd9dbe0})); me.position.y=base-1; me.raycast=()=>{}; scene.add(me);
      }
    }
    novo(l,l.t==="shopping"?34:l.t==="estadio"?22:14,"");
  }
  for(const [k,gs] of Object.entries(geos)){
    const mt=semZ(new THREE.MeshLambertMaterial({color:CORC[k]})); if(k==="parque"){ mt.polygonOffsetFactor=-1; mt.polygonOffsetUnits=-2; }
    const me=new THREE.Mesh(mergeGeometries(gs),mt); me.receiveShadow=true; me.raycast=()=>{}; scene.add(me);
  }
  for(const [t,cs] of Object.entries(contornos)){
    const mat=semZ(new THREE.MeshLambertMaterial({color:COR_LUGAR[t]||"#6b7280",side:THREE.DoubleSide}));
    if(cs.perto.length) scene.add(new THREE.Mesh(fita(cs.perto,.2),mat));
    if(cs.longe.length) scene.add(new THREE.Mesh(fita(cs.longe,2.5,H),mat));
  }

  // trilhos na superfície: junta os trechos em cadeias e põe um trem em cada uma (dentro da maquete)
  const segs=E.trilhos.filter(t=>!t.tunel).map(t=>({k:t.k,p:pares(t.p)}));
  const chave=([x,z])=>Math.round(x)+","+Math.round(z);
  let perto=null;
  while(segs.length){
    const s0=segs.shift(); let pts=s0.p.slice(), mudou=true;
    while(mudou){ mudou=false;
      for(let i=0;i<segs.length;i++){ const t=segs[i]; if(t.k!==s0.k) continue;
        const a=chave(pts[0]), b=chave(pts[pts.length-1]), c=chave(t.p[0]), d=chave(t.p[t.p.length-1]);
        if(b===c) pts=pts.concat(t.p.slice(1)); else if(b===d) pts=pts.concat(t.p.slice().reverse().slice(1));
        else if(a===d) pts=t.p.slice(0,-1).concat(pts); else if(a===c) pts=t.p.slice().reverse().slice(0,-1).concat(pts); else continue;
        segs.splice(i,1); mudou=true; break; } }
    // só o que está dentro da maquete, em trechos contínuos de mais de 700 m
    let run=[];
    const fecha=()=>{ if(run.length>1){ const acum=[0]; for(let i=1;i<run.length;i++) acum.push(acum[i-1]+Math.hypot(run[i][0]-run[i-1][0],run[i][1]-run[i-1][1]));
      if(acum[acum.length-1]>700) trens.push({k:s0.k,pts:run,acum,L:acum[acum.length-1]}); } run=[]; };
    for(const q of pts){ if(Math.hypot(q[0],q[1])<2480) run.push(q); else fecha();
      if(s0.k==="metro"){ const m=Math.hypot(q[0],q[1]); if(!perto||m<perto.m) perto={x:q[0],y:-q[1],m}; } }
    fecha();
  }
  const MAT_TREM={metro:[0xd5d9df,0xd5d9df,0x8b929c,0x555b66,0xe11d2e,0xe11d2e],trem:[0xd5d9df,0xd5d9df,0x8b929c,0x555b66,0x0e7490,0x0e7490]};
  const geoCarro=new THREE.BoxGeometry(3,3.6,19.6).translate(0,1.8,0);
  trens.forEach((tr,i)=>{
    const mats=MAT_TREM[tr.k].map(c=>new THREE.MeshLambertMaterial({color:c}));
    tr.carros=Array.from({length:tr.k==="metro"?6:8},()=>{ const m=new THREE.Mesh(geoCarro,mats); m.visible=false; m.raycast=()=>{}; scene.add(m); return m; });
    tr.v=tr.k==="metro"?15:13; tr.volta=i%2===1; tr.off=(i*977)%(tr.L+500);
  });

  // estações (uma por nome, até ~3,3 km)
  const vistas=new Set();
  for(const st of E.estacoes){
    if(st.m>3300||vistas.has(st.n)) continue; vistas.add(st.n);
    novo({n:st.n,t:st.k,x:st.x,y:st.y,m:st.m,area:0},10,"est").perto=5200;
  }

  // cartão com a lista
  const lista=lugares.slice().sort((a,b)=>(a.l.t==="metro"||a.l.t==="trem")-(b.l.t==="metro"||b.l.t==="trem")||a.l.m-b.l.m);
  document.getElementById("destaquesLista").innerHTML=lista.map(q=>`<button type="button" data-i="${lugares.indexOf(q)}" style="--c:${COR_LUGAR[q.l.t]||"#6b7280"}"><i></i><b>${q.l.t==="metro"||q.l.t==="trem"?L("Estação ","")+esc(q.l.n)+L(""," station"):esc(q.l.n)}</b><span>${L(...tipoL(q.l.t))} · ${dist(q.l.m)}</span></button>`).join("");
  document.getElementById("destaquesLista").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b) irLugar(lugares[+b.dataset.i]); });
  document.getElementById("cartaoDestaques").hidden=!lista.length;
});

// ---------- chunks do anel (1 a 2,3 km): casas, árvores, calçadas e lajes das torres, carregados perto da câmera ----------
// Como nos jogos: o bairro.json traz o "longe" do anel (torres, ruas, praças) e cada quadrado de 500 m (chunks/c_i_j.json)
// acrescenta o resto quando o ponto para onde a câmera olha chega perto. Fica no máximo um punhado carregado; o que
// ficou longe sai da memória. O chunk entra com um fade e a neblina esconde a borda do que ainda não carregou.
const chunks=(()=>{
  const T=500, MAX=MODESTO?9:16, R_IN=MODESTO?650:850, R_OUT=R_IN+450, carregados=new Map();
  const MAT={jan0:matJan[0],jan1:matJan[1],jan2:matJan[2],lisa:matLisa,tel:matTel};
  const chave=(i,j)=>i+","+j, grupo=new THREE.Group(); scene.add(grupo);
  // torres do anel (já desenhadas pelo bairro.json, sem lajes) e ruas do anel, por chunk
  const torresCel=new Map(), ruasCel=new Map(), poe=(m,k,v)=>(m.get(k)||m.set(k,[]).get(k)).push(v);
  predios.forEach((b,i)=>{ if(!b.anel||b.h<18||b.oculto||b.esp) return;
    let cx=0,cy=0; for(let k=0;k<b.p.length;k+=2){ cx+=b.p[k]; cy+=b.p[k+1]; } const n=b.p.length/2;
    poe(torresCel,chave(Math.floor(cx/n/T),Math.floor(cy/n/T)),i); });
  for(const r of B.anel?.ruas||[]){ if(!VIAS.has(r.k)) continue; const m=Math.floor(r.p.length/4)*2;
    poe(ruasCel,chave(Math.floor(r.p[m]/T),Math.floor(r.p[m+1]/T)),r); }
  let IDX=null, ocupado=false, ultimo=0, liberado=false;
  // só depois da animação de abertura: na chegada, a placa de vídeo já tem trabalho de sobra
  addEventListener("bairro3d-pronto",()=>setTimeout(async()=>{
    // aquece os shaders do fade (material transparente é outro programa na placa de vídeo): sem isso, o primeiro chunk
    // travava ~200 ms compilando no meio do voo
    const tmp=new THREE.Group(), gq=new THREE.BufferGeometry(); gq.setAttribute("position",new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
    for(const k of CHAVES){ const m=MAT[k].clone(); m.transparent=true; const me=new THREE.Mesh(geo({p:{fim:()=>new Float32Array(9)},n:{fim:()=>new Float32Array(9)},uv:{fim:()=>new Float32Array(6)},c:{fim:()=>new Float32Array(9)}}),m); me.castShadow=me.receiveShadow=true; tmp.add(me); }
    for(const m0 of [...ARV_MATS,ARV_MAT_TRONCO]){ const m=m0.clone(); m.transparent=true; const im=new THREE.InstancedMesh(ARV_TIPOS[0],m,1); im.setColorAt(0,new THREE.Color()); im.castShadow=true; tmp.add(im); }
    for(const [m0,T] of [[matAresta,THREE.LineSegments],[postes.material,THREE.Points]]){ const m=m0.clone(); m.transparent=true; tmp.add(new T(gq,m)); }
    { const m=matPasseio.clone(); m.transparent=true; const me=new THREE.Mesh(gq,m); me.receiveShadow=true; tmp.add(me); }
    try{ await renderer.compileAsync(tmp,camera,scene); }catch(e){}
    tmp.traverse(o=>{ if(o.material) o.material.dispose(); if(o.isInstancedMesh) o.dispose(); else if(o.geometry&&o.geometry!==ARV_TIPOS[0]) o.geometry.dispose(); });
    liberado=true;
  },semMovimento?0:3200),{once:true});
  fetch(DADOS+"chunks/index.json").then(r=>r.ok?r.json():null).then(d=>{ if(d) IDX=d.cel.map(([i,j,np,na])=>({i,j,k:chave(i,j),np,na})); }).catch(()=>{});
  const aviso=document.createElement("div"); aviso.className="chunkAviso"; aviso.innerHTML=L("Carregando a região…","Loading this area…"); aviso.hidden=true; palco.appendChild(aviso);
  const quadro=()=>new Promise(r=>requestAnimationFrame(r));
  // chão: dentro de um chunk carregado vira cor de calçada (as casas estão lá); fora continua cor de telhado
  function pintaChao(i,j,perto){
    const u=chao.userData, A=chao.geometry.attributes.color, src=perto?u.corPerto:u.corOrig;
    const c0=Math.max(0,Math.ceil((i*T+u.R)/u.P)), c1=Math.min(u.N-1,Math.floor(((i+1)*T+u.R)/u.P));
    const r0=Math.max(0,Math.ceil((-(j+1)*T+u.R)/u.P)), r1=Math.min(u.N-1,Math.floor((-j*T+u.R)/u.P));   // z = −norte
    for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){ const v=3*(r*u.N+c); A.array[v]=src[v]; A.array[v+1]=src[v+1]; A.array[v+2]=src[v+2]; }
    A.needsUpdate=true;
  }
  async function carrega(c){
    const e={c,st:"carregando",g:null,malhas:[],lajes:[],fade:0}; carregados.set(c.k,e); ocupado=true; aviso.hidden=false;
    try{
      const d=await (await fetch(`${DADOS}chunks/c_${c.i}_${c.j}.json`)).json();
      if(e.st==="cancelado") return;
      // índices próprios por chunk: cores e árvores estáveis, e o clique acha o prédio pelo índice
      const s0=1e6+((c.i+60)*120+(c.j+60))*4000, lista=d.predios;
      const st={buf:Object.fromEntries(CHAVES.map(k=>[k,novoBuf()])),triDono:Object.fromEntries(CHAVES.map(k=>[k,[]])),arestas:[]};
      const torres=torresCel.get(c.k)||[];
      // constrói em fatias de ~6 ms para não travar a animação (o voo da câmera continua liso)
      for(let n=0;n<lista.length+torres.length;){
        const sv={buf,triDono,arestas}; buf=st.buf; triDono=st.triDono; arestas=st.arestas; lajeFixa="laje:ch";
        const t0=performance.now();
        try{
          for(;n<lista.length+torres.length&&performance.now()-t0<6;n++){
            if(n<lista.length) construirPredio(lista[n],s0+n,true);
            else { const i=torres[n-lista.length], b=predios[i];
              detalhaTorre(i,contornoPredio(b.p),b.base,b.h,corPredio(b.h,i)); }
          }
        } finally { st.arestas=arestas; buf=sv.buf; triDono=sv.triDono; arestas=sv.arestas; lajeFixa=null; }
        await quadro(); if(e.st==="cancelado") return;
      }
      const g=new THREE.Group();
      for(const k of CHAVES){ if(!st.buf[k].p.n) continue;
        const me=new THREE.Mesh(geo(st.buf[k]),MAT[k]); me.castShadow=me.receiveShadow=true;
        me.userData.chunk={lista,s0,donos:Uint32Array.from(st.triDono[k])};
        const soPos=new THREE.BufferGeometry(); soPos.setAttribute("position",me.geometry.attributes.position);
        me.raycast=(rc,out)=>{ const gg=me.geometry; me.geometry=soPos; THREE.Mesh.prototype.raycast.call(me,rc,out); me.geometry=gg; };
        g.add(me); e.malhas.push(me); }
      if(st.buf["laje:ch"]?.p.n){
        const me=new THREE.Mesh(geo(st.buf["laje:ch"]),matLisa); me.castShadow=me.receiveShadow=true; me.raycast=()=>{}; g.add(me);
        const l={m:me,c:new THREE.Vector3((c.i+.5)*T,0,-(c.j+.5)*T),r:1000}; lajesLOD.push(l); e.lajes.push(l); }
      if(st.arestas.length){ const gl=new THREE.BufferGeometry(); gl.setAttribute("position",new THREE.Float32BufferAttribute(st.arestas,3)); g.add(new THREE.LineSegments(gl,matAresta)); }
      const ruas=ruasCel.get(c.k);
      if(ruas?.length){ const m=new THREE.Mesh(fita(ruas.map(r=>({...r,w:r.w+3.4})),.03),matPasseio); m.receiveShadow=true; m.raycast=()=>{}; g.add(m);
        // postes (acesos só à noite), no mesmo espaçamento do raio de 1 km
        const P=[];
        for(const r of ruas){ const cm=caminho(r);
          for(let d=12;d<cm.L;d+=32){ const [x,z,a]=ponto(cm,d), o=r.w/2+1.2, l=(Math.floor(d/32)%2)?1:-1;
            const px=x+Math.cos(a)*o*l, pz=z-Math.sin(a)*o*l; P.push(px,hZ(px,pz)+7,pz); } }
        if(P.length){ const gp=new THREE.BufferGeometry(); gp.setAttribute("position",new THREE.Float32BufferAttribute(P,3));
          const pt=new THREE.Points(gp,postes.material); pt.visible=postes.visible; pt.raycast=()=>{}; e.postes=pt; g.add(pt); } }
      plantaArvores(d.arvores,g,s0,false);
      // fade: cada malha começa com uma cópia transparente do material e volta ao material comum no fim
      g.traverse(o=>{ if(!o.material) return; o.userData.matOrig=o.material; const m=o.material.clone(); m.transparent=true; m.opacity=0; o.material=m; });
      e.g=g; e.st="pronto"; e.fade=performance.now(); grupo.add(g); malhasPredios.push(...e.malhas); pintaChao(c.i,c.j,true);
    }catch(err){ carregados.delete(c.k); console.warn("chunk",c.k,err); }
    finally{ ocupado=false; aviso.hidden=true; }
  }
  function descarrega(k){
    const e=carregados.get(k); if(!e) return; carregados.delete(k);
    if(e.st!=="pronto"){ e.st="cancelado"; return; }
    grupo.remove(e.g);
    e.g.traverse(o=>{ if(o.isInstancedMesh) o.dispose(); else if(o.geometry) o.geometry.dispose();
      if(o.material&&o.userData.matOrig&&o.material!==o.userData.matOrig) o.material.dispose(); });
    for(const m of e.malhas){ const i=malhasPredios.indexOf(m); if(i>=0) malhasPredios.splice(i,1); }
    for(const l of e.lajes){ const i=lajesLOD.indexOf(l); if(i>=0) lajesLOD.splice(i,1); }
    pintaChao(e.c.i,e.c.j,false);
  }
  const distCel=(c,x,y)=>Math.hypot(Math.max(c.i*T-x,0,x-(c.i+1)*T),Math.max(c.j*T-y,0,y-(c.j+1)*T));
  return {grupo,carregados,
    quadro(agora){
      for(const e of carregados.values()) if(e.st==="pronto"&&e.fade){
        const t=Math.min(1,(agora-e.fade)/700);
        e.g.traverse(o=>{ if(!o.userData.matOrig) return;
          if(t<1) o.material.opacity=t*(o.userData.matOrig.opacity??1);
          else { const m=o.material; o.material=o.userData.matOrig; m.dispose(); } });
        if(t>=1) e.fade=0;
      }
      if(!IDX||!liberado||agora-ultimo<200) return; ultimo=agora;
      for(const e of carregados.values()) if(e.postes) e.postes.visible=postes.visible;
      // foco: para onde a câmera olha (durante um voo, o destino, para já ir carregando lá)
      const alvo=anim?anim.a1:controls.target, fx=alvo.x, fy=-alvo.z;
      const dCam=(anim?anim.p1:camera.position).distanceTo(alvo), rIn=dCam<2200?R_IN:0;
      for(const [k,e] of carregados) if(distCel(e.c,fx,fy)>Math.max(rIn,400)+R_OUT-R_IN) descarrega(k);
      const quer=IDX.filter(c=>!carregados.has(c.k)&&distCel(c,fx,fy)<rIn).sort((a,b)=>distCel(a,fx,fy)-distCel(b,fx,fy));
      if(quer.length&&!ocupado){
        if(carregados.size>=MAX){   // cheio: sai o mais longe, se estiver mais longe que o que entra
          const [k,e]=[...carregados].filter(([,e])=>e.st==="pronto").sort((a,b)=>distCel(b[1].c,fx,fy)-distCel(a[1].c,fx,fy))[0]||[];
          if(e&&distCel(e.c,fx,fy)>distCel(quer[0],fx,fy)) descarrega(k); else return;
        }
        carrega(quer[0]);
      }
    }};
})();

// ---------- modo Rua: câmera na altura dos olhos; arrastar olha em volta, clicar no chão anda até lá ----------
const rua=(()=>{
  const OLHO=1.65, VEL=14, vias=todasRuas.filter(r=>VIAS.has(r.k));
  const bt=document.getElementById("btRua"), dica=document.createElement("div"), mira=document.createElement("div");
  dica.className="dicaRua"; dica.hidden=true; mira.className="miraRua"; mira.hidden=true; palco.append(dica,mira);
  let ativo=false, guardado=null, yaw=0, pitch=0, ida=null, arr=null; const teclas=new Set();
  const rc=new THREE.Raycaster(), dir=new THREE.Vector3(), tmp=new THREE.Vector3();
  const noChao=(x,z)=>hZ(x,z)+OLHO;
  function pontoNaRua(x,z){   // ponto de rua mais perto (x/z da cena), sobre o eixo
    let m=1e12, p=null;
    for(const r of vias){ const a=r.p; for(let i=0;i+3<a.length;i+=2){
      const ax=a[i], az=-a[i+1], bx=a[i+2], bz=-a[i+3], vx=bx-ax, vz=bz-az, L=vx*vx+vz*vz;
      const t=L?Math.max(0,Math.min(1,((x-ax)*vx+(z-az)*vz)/L)):0, qx=ax+t*vx, qz=az+t*vz, d=(qx-x)**2+(qz-z)**2;
      if(d<m){ m=d; p=[qx,qz,Math.atan2(-vx,-vz)]; } } }
    return p;
  }
  function olhar(){ camera.rotation.set(pitch,yaw,0,"YXZ"); camera.getWorldDirection(dir); controls.target.copy(camera.position).addScaledVector(dir,1); }
  function bloqueio(de,para){   // prédio no caminho: para 1,5 m antes
    tmp.copy(para).sub(de); const L=Math.hypot(tmp.x,tmp.z); if(L<.01) return para;
    tmp.y=0; tmp.normalize(); rc.set(new THREE.Vector3(de.x,de.y-.4,de.z),tmp); rc.far=L+1.5;
    const h=rc.intersectObjects(malhasPredios,false)[0];
    if(!h) return para;
    const k=Math.max(0,h.distance-1.5); const p=de.clone().addScaledVector(tmp,k); p.y=noChao(p.x,p.z); return p;
  }
  function entrar(){
    if(ativo) return; anim=null;
    guardado={pos:camera.position.clone(),alvo:controls.target.clone(),near:camera.near,far:camera.far,fov:camera.fov};
    const alvo=controls.target, az=Math.atan2(camera.position.x-alvo.x,camera.position.z-alvo.z);
    const p=pontoNaRua(alvo.x,alvo.z)||[alvo.x,alvo.z];
    ativo=true; controls.enabled=false; controls.autoRotate=false;
    camera.position.set(p[0],noChao(p[0],p[1]),p[1]);
    // olha ao longo da rua, no sentido mais parecido com o da câmera de cima
    yaw=az; pitch=.04;
    if(p.length>2){ const d=a=>Math.abs(Math.atan2(Math.sin(a-az),Math.cos(a-az))); yaw=d(p[2])<=d(p[2]+Math.PI)?p[2]:p[2]+Math.PI; }
    camera.near=.3; camera.far=20000; camera.fov=62; camera.updateProjectionMatrix(); olhar();
    bt.setAttribute("aria-pressed",true); fecharBalao();
    dica.innerHTML=matchMedia("(pointer:coarse)").matches?L("Arraste para olhar · toque no chão para andar","Drag to look around · tap the ground to walk"):L("Arraste para olhar · clique no chão ou use W A S D · Esc sai","Drag to look around · click the ground or use W A S D · Esc exits");
    dica.hidden=false; clearTimeout(dica._t); dica._t=setTimeout(()=>dica.hidden=true,6000);
  }
  function sair(restaura=true){
    if(!ativo) return; ativo=false; ida=null; teclas.clear(); mira.hidden=dica.hidden=true;
    camera.near=guardado.near; camera.far=guardado.far; camera.fov=guardado.fov; camera.updateProjectionMatrix(); camera.up.set(0,1,0);
    // de volta ao alto, sobre o ponto onde a caminhada terminou
    const a=new THREE.Vector3(camera.position.x,hZ(camera.position.x,camera.position.z),camera.position.z);
    if(restaura){ const v=guardado.pos.clone().sub(guardado.alvo); camera.lookAt(a); anim={t0:performance.now(),dur:900,p0:camera.position.clone(),a0:controls.target.clone(),p1:a.clone().add(v),a1:a}; }
    controls.enabled=true; bt.setAttribute("aria-pressed",false);
  }
  bt.onclick=()=>ativo?sair():entrar();
  const el=renderer.domElement;
  el.addEventListener("pointerdown",e=>{ if(ativo){ arr={x:e.clientX,y:e.clientY,yaw,pitch}; el.setPointerCapture?.(e.pointerId); } });
  el.addEventListener("pointermove",e=>{
    if(!ativo) return;
    if(arr&&e.buttons){ const k=(e.pointerType==="touch"?.006:.004)*(camera.fov/40);
      yaw=arr.yaw+(e.clientX-arr.x)*k; pitch=Math.max(-1.2,Math.min(1.2,arr.pitch+(e.clientY-arr.y)*k)); olhar(); mira.hidden=true; return; }
    if(e.pointerType!=="mouse") return;
    const h=raioTela(e); mira.hidden=!(h&&h.object===chao);
    if(!mira.hidden){ const r=palco.getBoundingClientRect(); mira.style.left=`${e.clientX-r.left}px`; mira.style.top=`${e.clientY-r.top}px`; }
  });
  el.addEventListener("pointerup",()=>{ arr=null; });
  function raioTela(e){ const r=el.getBoundingClientRect();
    rc.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera); rc.far=900;
    const h=rc.intersectObjects([...malhasPredios,chao],false)[0]; rc.far=Infinity; return h; }
  // clique no chão: anda até lá. Devolve true se tratou o clique (prédio segue o fluxo normal: abre os detalhes)
  function toque(e){
    const h=raioTela(e); if(!h) return true;
    if(h.object!==chao) return false;
    const fim=bloqueio(camera.position,new THREE.Vector3(h.point.x,noChao(h.point.x,h.point.z),h.point.z));
    const L=camera.position.distanceTo(fim); if(L<.5) return true;
    ida={t0:performance.now(),dur:Math.min(6000,Math.max(450,L/VEL*1000)),p0:camera.position.clone(),p1:fim};
    dica.hidden=true; return true;
  }
  addEventListener("keydown",e=>{
    if(!ativo||e.target.closest?.("input,select,textarea")) return;
    if(e.key==="Escape"){ sair(); return; }
    const k=e.key.toLowerCase(); if(["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright","shift"].includes(k)){ teclas.add(k); if(k!=="shift") e.preventDefault(); }
  });
  addEventListener("keyup",e=>teclas.delete(e.key.toLowerCase()));
  addEventListener("blur",()=>teclas.clear());
  function quadro(dt){
    if(!ativo) return;
    if(anim) { sair(false); return; }    // outra parte do app pediu um voo (lista de lugares, câmeras): ele assume
    if(ida){ const t=Math.min(1,(performance.now()-ida.t0)/ida.dur), k=t<.5?2*t*t:1-(-2*t+2)**2/2;
      camera.position.lerpVectors(ida.p0,ida.p1,k); camera.position.y=noChao(camera.position.x,camera.position.z); if(t>=1) ida=null; }
    const f=(teclas.has("w")||teclas.has("arrowup")?1:0)-(teclas.has("s")||teclas.has("arrowdown")?1:0);
    const l=(teclas.has("d")?1:0)-(teclas.has("a")?1:0), giro=(teclas.has("arrowleft")?1:0)-(teclas.has("arrowright")?1:0);
    if(giro) yaw+=giro*1.6*dt;
    if(f||l){ ida=null; const v=VEL*(teclas.has("shift")?3:1)*dt;
      const fx=-Math.sin(yaw), fz=-Math.cos(yaw), p=camera.position.clone();
      p.x+=(fx*f+(-fz)*l)*v; p.z+=(fz*f+fx*l)*v; p.y=noChao(p.x,p.z);
      camera.position.copy(bloqueio(camera.position,p)); }
    olhar();
  }
    return {quadro,toque,sair,get ativo(){ return ativo; }};
})();

// ---------- laço ----------
const agulha=document.getElementById("agulha");
// pílula com o nome do centro: volta a câmera para lá
const rotulo=document.createElement("button"); rotulo.type="button"; rotulo.className="lugar centro"; rotulo.style.setProperty("--c","#b99a5b");
rotulo.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>${esc(NOME)}`;
rotulo.addEventListener("click",voltarAoCentro); palco.appendChild(rotulo);
const topoC=new THREE.Vector3(C.x,hZ(0,0)+Math.max(30,alturaEm(0,0)-hZ(0,0)+12),C.z);
function tamanho(){
  const w=palco.clientWidth, h=palco.clientHeight;
  renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix();
}
new ResizeObserver(tamanho).observe(palco); tamanho();
const ease=t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
{ const [p,a]=CAMS[0][1]();
  if(semMovimento){ camera.position.copy(p); controls.target.copy(a); }
  else { // "zoom" de chegada: começa bem alto, quase na vertical, e desce girando até a visão geral
    const p0=C.clone().add(new THREE.Vector3(420,1700,-260)), a0=C.clone();
    camera.position.copy(p0); controls.target.copy(a0);
    anim={t0:performance.now()+250,dur:2800,p0,a0,p1:p,a1:a};
  }
}
infoCentro();
{ const el=document.getElementById("carregando");
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ palco.classList.add("pronto"); el.classList.add("sai");
    dispatchEvent(new Event("bairro3d-pronto")); }));
  setTimeout(()=>el.remove(),1400); }
const projeta=(pos,el,margemTopo=60)=>{ const w=pos.clone().project(camera);
  const ok=w.z<1&&Math.abs(w.x)<1.02&&Math.abs(w.y)<1.02&&(1-w.y)/2*palco.clientHeight>margemTopo;
  if(ok){ el.style.left=`${(w.x+1)/2*palco.clientWidth}px`; el.style.top=`${(1-w.y)/2*palco.clientHeight}px`; }
  return ok; };
// ---------- ao vivo: bicicletas do Bike Itaú, aviões (ADS-B) e o tempo agora (o servidor busca e guarda em cache: /api/*) ----------
const aoVivo=(()=>{
  const kx=B.meta.m_por_grau.lon, ky=B.meta.m_por_grau.lat, o=B.meta.origem, base=RM?.base_altitude||0;
  const xy=(lat,lon)=>[(lon-o.lon)*kx,(lat-o.lat)*ky];
  const api=f=>fetch("api/"+f).then(r=>r.ok?r.json():null).catch(()=>null);
  const visivel=()=>document.visibilityState==="visible";
  const salvo=(k,pad)=>{ try{ const v=localStorage.getItem("bairro3d-"+k); return v==null?pad:v==="1"; }catch(e){ return pad; } };
  const salva=(k,v)=>{ try{ localStorage.setItem("bairro3d-"+k,v?"1":"0"); }catch(e){} };
  const hora=t=>t?new Date(t*1000).toLocaleTimeString(EN()?"en-GB":"pt-BR",{hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"}):"";

  // --- bicicletas: pílula por estação com quantas estão livres agora ---
  const ICONE_BIKE='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l-1.5-3H6M15 9l-2 7H6"/></svg>';
  const btBike=document.getElementById("btBike"), estacoes=new Map();
  let verBike=salvo("bike",false), tBike=0;
  const corBike=e=>!e.ok?"#6b7280":e.b===0?"#dc2626":e.b<3?"#d97706":"#16a34a";
  const htmlBike=e=>`<b>${esc(e.n)}</b><div class="tipo"><i style="background:${corBike(e)}"></i>Bike Itaú · ${dist(Math.hypot(...xy(e.lat,e.lon)))} ${DO_C}</div>
    ${e.ok?`<dl class="precos"><dt>${L("Bicicletas livres","Bikes available")}</dt><dd>${e.b}</dd><dt>${L("Elétricas","E-bikes")}</dt><dd>${e.e}</dd><dt>${L("Vagas para devolver","Free docks")}</dt><dd>${e.v}</dd></dl>`
      :`<p>${L("Estação fora de operação agora.","Station not in service right now.")}</p>`}
    ${e.end?`<p>${esc(e.end)}</p>`:""}<p class="mt">${L("Atualizado às","Updated at")} ${hora(e.t)} · ${L("dados ao vivo","live data")}</p>`;
  async function bike(){
    const D=await api("bike"); tBike=performance.now(); if(!D) return;
    for(const e of D.estacoes){
      let q=estacoes.get(e.id);
      if(!q){
        const [x,y]=xy(e.lat,e.lon), h0=hZ(x,-y), el=document.createElement("button"); el.type="button"; el.className="posto bike"; el.style.display="none";
        palco.appendChild(el); q={el,pos:new THREE.Vector3(x,h0+4,-y),topo:new THREE.Vector3(x,h0+14,-y)};
        el.addEventListener("click",()=>abrirBalao(q.topo,htmlBike(q.e))); estacoes.set(e.id,q);
      }
      q.e=e; q.el.innerHTML=ICONE_BIKE+(e.ok?e.b:"—"); q.el.style.setProperty("--c",corBike(e));
      q.el.setAttribute("aria-label",`${e.n}: ${e.b} ${T("bicicletas livres","bikes available")}`);
    }
  }
  btBike.setAttribute("aria-pressed",verBike);
  btBike.onclick=()=>{ verBike=!verBike; btBike.setAttribute("aria-pressed",verBike); salva("bike",verBike); if(verBike&&!estacoes.size) bike(); };

  // --- aviões: malha simples na altitude real + pílula com o voo; entre leituras, segue rumo e velocidade ---
  const btAvioes=document.getElementById("btAvioes"), avioes=new Map(), grupoAv=new THREE.Group(); scene.add(grupoAv);
  let verAv=salvo("avioes",false), tAv=0;
  const geoAv=(()=>{ const f=new THREE.CylinderGeometry(2,1.4,38,8); f.rotateX(Math.PI/2);
    const a=new THREE.BoxGeometry(34,.8,6), c=new THREE.BoxGeometry(12,.6,3.5); c.translate(0,0,16); const l=new THREE.BoxGeometry(.6,7,4); l.translate(0,3.5,17);
    return mergeGeometries([f.toNonIndexed(),a.toNonIndexed(),c.toNonIndexed(),l.toNonIndexed()]); })();
  const matAv=new THREE.MeshLambertMaterial({color:0xf8fafc,emissive:0x334155});
  const alt=m=>L(`${Math.round(m).toLocaleString("pt-BR")} m`,`${Math.round(m/.3048).toLocaleString("en-US")} ft`);
  const htmlAv=a=>`<b>${esc(a.voo||a.reg||a.hex)}</b><div class="tipo"><i style="background:#0ea5e9"></i>${esc([a.tipo,a.reg].filter(Boolean).join(" · ")||T("Aeronave","Aircraft"))}</div>
    <dl class="precos"><dt>${L("Altitude","Altitude")}</dt><dd>${alt(a.alt)}</dd><dt>${L("Velocidade","Speed")}</dt><dd>${Math.round(a.vel*3.6)} km/h</dd>
    <dt>${L("Rumo","Heading")}</dt><dd>${Math.round(a.rumo??0)}°</dd><dt>${L("Distância","Distance")}</dt><dd>${dist(Math.hypot(...xy(a.lat,a.lon)))}</dd></dl>
    <p>${a.sobe>1?L("Subindo","Climbing"):a.sobe<-1?L("Descendo","Descending"):L("Nível","Level")}${a.voo?` · <a href="https://globe.adsb.lol/?icao=${esc(a.hex)}" target="_blank" rel="noopener">adsb.lol</a>`:""}</p>`;
  async function voos(){
    const D=await api("voos"); tAv=performance.now(); if(!D) return;
    const vistos=new Set();
    for(const a of D.avioes){
      vistos.add(a.hex); let q=avioes.get(a.hex);
      const [x,y]=xy(a.lat,a.lon), p=new THREE.Vector3(x,Math.max(60,a.alt-base),-y);
      if(!q){
        const m=new THREE.Mesh(geoAv,matAv); m.scale.setScalar(3); grupoAv.add(m);
        const el=document.createElement("button"); el.type="button"; el.className="posto aviao"; el.style.display="none"; palco.appendChild(el);
        q={m,el,pos:p.clone()}; el.addEventListener("click",()=>irAoAviao(q)); avioes.set(a.hex,q);
      }
      if(q.pos.distanceTo(p)>3000) q.pos.copy(p);   // salto grande (avião novo ou leitura velha): sem deslizar pelo céu
      q.alvo=p; q.a=a;
      q.el.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2 7 7 4v2l-7-2-1 5 3 2v2l-4-1-4 1v-2l3-2-1-5-7 2v-2l7-4z"/></svg>${esc(a.voo||a.reg||a.hex)}`;
      q.el.setAttribute("aria-label",`${a.voo||a.hex}, ${Math.round(a.alt)} m`);
    }
    for(const [k,q] of avioes) if(!vistos.has(k)){ grupoAv.remove(q.m); q.el.remove(); avioes.delete(k); }
    const lista=[...avioes.values()].map(q=>[Math.hypot(q.pos.x,q.pos.z),q]).sort((a,b)=>a[0]-b[0]);
    listaAv.innerHTML=lista.map(([d,q])=>`<button type="button" data-hex="${esc(q.a.hex)}" style="--c:#0369a1"><i></i><b>${esc(q.a.voo||q.a.reg||q.a.hex)}</b><span>${esc(q.a.tipo||"")} · ${dist(d)} · ${q.a.sobe>1?L("subindo","climbing"):q.a.sobe<-1?L("descendo","descending"):L("nível","level")}</span><em>${alt(q.a.alt)}</em></button>`).join("")
      ||`<p>${L("Nenhum avião no raio agora.","No aircraft in range right now.")}</p>`;
  }
  function irAoAviao(q){ const v=q.pos.clone(), d=camera.position.clone().sub(v).setY(0); if(d.lengthSq()<1) d.set(0,0,1); d.normalize();
    voarPara(v.clone().add(d.multiplyScalar(900)).setY(v.y+250),v); setTimeout(()=>abrirBalao(q.pos,htmlAv(q.a)),1450); }
  const listaAv=document.getElementById("avioesLista"), cartaoAv=document.getElementById("cartaoAvioes");
  listaAv.addEventListener("click",e=>{ const b=e.target.closest("button[data-hex]"); const q=b&&avioes.get(b.dataset.hex); if(q){ irAoAviao(q); palco.scrollIntoView({behavior:"smooth",block:"center"}); } });
  btAvioes.setAttribute("aria-pressed",verAv);
  btAvioes.onclick=()=>{ verAv=!verAv; btAvioes.setAttribute("aria-pressed",verAv); salva("avioes",verAv); grupoAv.visible=verAv; cartaoAv.hidden=!verAv; if(verAv) voos(); };
  grupoAv.visible=verAv; cartaoAv.hidden=!verAv;


  // --- trânsito (TomTom): cor por trecho conforme a velocidade de agora ÷ a livre; interdições e acidentes como pílulas ---
  const btTransito=document.getElementById("btTransito"), grupoTr=new THREE.Group(), cartaoTr=document.getElementById("cartaoTransito"); scene.add(grupoTr);
  const FAIXAS=[[.8,0x2fbf71,.55,["livre","free flow"]],[.6,0xf2c94c,.8,["moderado","moderate"]],[.4,0xf2994a,.85,["lento","slow"]],[0,0xe5484d,.9,["parado","stopped"]]];
  const matsTr=FAIXAS.map(([,c,op])=>new THREE.MeshBasicMaterial({color:c,transparent:true,opacity:op,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2}));
  const matInc=new THREE.MeshBasicMaterial({color:0x7c3aed,transparent:true,opacity:.95,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-4});
  const ICONE_INC='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>';
  const celulas=new Map(), CEL=15, incidentes=[];
  let verTr=salvo("transito",false), tTr=0, D_tr=null;
  const quando=t=>t?new Date(t).toLocaleString(EN()?"en-GB":"pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit",timeZone:"America/Sao_Paulo"}):"";
  const htmlInc=i=>`<b>${esc(i.tipo[0].toUpperCase()+i.tipo.slice(1))}</b><div class="tipo"><i style="background:#7c3aed"></i>${esc(i.de)}${i.ate&&i.ate!==i.de?" → "+esc(i.ate):""}</div>
    ${i.desc&&!/^Encerrad/.test(i.desc)?`<p>${esc(i.desc)}</p>`:""}<p>${i.inicio?L("Desde ","Since ")+quando(i.inicio):""}${i.fim?L(" · previsão de fim "," · expected end ")+quando(i.fim):""}${i.atraso?` · ${L("atraso","delay")} ~${Math.round(i.atraso/60)} min`:""}${i.metros?` · ${dist(i.metros)}`:""}</p><p class="mt">TomTom · ${L("ao vivo","live")}</p>`;
  async function transitoCarrega(){
    const D=await api("transito"); tTr=performance.now();
    if(!D){ if(!D_tr){ btTransito.hidden=true; cartaoTr.hidden=true; } return; }
    D_tr=D;
    for(const m of [...grupoTr.children]){ grupoTr.remove(m); m.geometry.dispose(); }
    for(const q of incidentes) q.el.remove(); incidentes.length=0; celulas.clear();
    const linhas=D.linhas.map(l=>{ const p=[]; for(let i=0;i<l.p.length;i+=2) p.push(...xy(l.p[i],l.p[i+1])); return {p,n:l.n,w:l.w?8:5}; });
    FAIXAS.forEach(([min],k)=>{ const sel=linhas.filter(l=>l.n>=min&&(k===0||l.n<FAIXAS[k-1][0]));
      if(sel.length){ const m=new THREE.Mesh(fita(sel,.35),matsTr[k]); m.renderOrder=1; grupoTr.add(m); } });
    for(const l of linhas){ const q=pares(l.p);
      for(let i=0;i<q.length-1;i++){ const [x1,z1]=q[i],[x2,z2]=q[i+1], s=Math.max(1,Math.ceil(Math.hypot(x2-x1,z2-z1)/8));
        for(let j=0;j<=s;j++){ const c=`${Math.floor((x1+(x2-x1)*j/s)/CEL)},${Math.floor((z1+(z2-z1)*j/s)/CEL)}`; celulas.set(c,Math.min(celulas.get(c)??1,l.n)); } } }
    for(const i of D.incidentes){
      if(i.linha.length>3){ const p=[]; for(let k=0;k<i.linha.length;k+=2) p.push(...xy(i.linha[k],i.linha[k+1]));
        const m=new THREE.Mesh(fita([{w:5,p}],.55),matInc); m.renderOrder=3; grupoTr.add(m); }
      const [x,y]=xy(i.lat,i.lon), h=hZ(x,-y), el=document.createElement("button"); el.type="button"; el.className="posto incidente"; el.style.display="none";
      el.innerHTML=ICONE_INC+esc(i.tipo); palco.appendChild(el);
      const q={el,i,pos:new THREE.Vector3(x,h+3,-y),topo:new THREE.Vector3(x,h+10,-y)}; el.addEventListener("click",()=>abrirBalao(q.topo,htmlInc(i))); incidentes.push(q);
    }
    const tot=linhas.length||1, lentos=linhas.filter(l=>l.n<.6).length;
    document.getElementById("transitoInfo").innerHTML=L(`Atualizado às ${hora(Date.now()/1000)} · ${Math.round(lentos/tot*100)}% dos trechos com lentidão.`,`Updated at ${hora(Date.now()/1000)} · ${Math.round(lentos/tot*100)}% of segments slow.`)+
      ` <span class="legTr">${FAIXAS.map(([,c,,n])=>`<i style="background:#${c.toString(16).padStart(6,"0")}"></i>${L(...n)}`).join("")}</span>`;
    document.getElementById("incidentesLista").innerHTML=incidentes.map((q,k)=>`<button type="button" data-k="${k}" style="--c:#7c3aed"><i></i><b>${esc(q.i.tipo)}</b><span>${esc(q.i.de)}${q.i.ate&&q.i.ate!==q.i.de?" → "+esc(q.i.ate):""}</span><em>${dist(Math.hypot(q.pos.x,q.pos.z))}</em></button>`).join("")
      ||`<p>${L("Nenhuma interdição, acidente ou obra no raio agora.","No closures, crashes or roadworks in range right now.")}</p>`;
    grupoTr.visible=verTr;
  }
  document.getElementById("incidentesLista").addEventListener("click",e=>{ const b=e.target.closest("button[data-k]"); const q=b&&incidentes[+b.dataset.k]; if(!q) return;
    const d=camera.position.clone().sub(controls.target).setY(0).normalize(); voarPara(q.pos.clone().add(d.multiplyScalar(300)).setY(q.pos.y+220),q.pos.clone());
    setTimeout(()=>abrirBalao(q.topo,htmlInc(q.i)),1450); palco.scrollIntoView({behavior:"smooth",block:"center"}); });
  function transitoLiga(v){ verTr=v; btTransito.setAttribute("aria-pressed",v); salva("transito",v); grupoTr.visible=v; cartaoTr.hidden=!v; if(v&&!D_tr) transitoCarrega(); }
  btTransito.onclick=()=>transitoLiga(!verTr);
  nivelEm=(x,z)=>verTr?(celulas.get(`${Math.floor(x/CEL)},${Math.floor(z/CEL)}`)??1):1;   // carros andam mais devagar onde está lento
  transitoLiga(verTr);

  // --- tempo agora: selo no canto da maquete; com chuva, cai chuva na cena ---
  const selo=document.getElementById("clima");
  const WMO=c=>c===0?["Céu limpo","Clear sky"]:c<=2?["Poucas nuvens","Partly cloudy"]:c===3?["Nublado","Overcast"]:c<=48?["Neblina","Fog"]:c<=57?["Garoa","Drizzle"]:
    c<=67?["Chuva","Rain"]:c<=77?["Neve","Snow"]:c<=82?["Pancadas de chuva","Rain showers"]:["Tempestade","Thunderstorm"];
  const chuva=(()=>{ const n=MODESTO?2500:7000, p=new Float32Array(n*3);
    for(let i=0;i<n;i++){ p[i*3]=(Math.random()-.5)*1600; p[i*3+1]=Math.random()*700; p[i*3+2]=(Math.random()-.5)*1600; }
    const g=new THREE.BufferGeometry(); g.setAttribute("position",new THREE.BufferAttribute(p,3));
    const pts=new THREE.Points(g,new THREE.PointsMaterial({color:0xaabbd0,size:1.6,transparent:true,opacity:.55,depthWrite:false}));
    pts.visible=false; pts.frustumCulled=false; scene.add(pts); return pts; })();
  let C_=null;
  async function clima(){
    C_=await api("clima"); if(!C_){ selo.hidden=true; return; }
    const [pt,en]=WMO(C_.codigo);
    selo.innerHTML=`<b>${Math.round(C_.temp)}°</b><span>${L(pt,en)}${C_.chuva_prob_6h>=50&&C_.chuva_mm===0?L(` · ${C_.chuva_prob_6h}% de chuva até ${6}h`,` · ${C_.chuva_prob_6h}% rain in 6h`):""}</span>`;
    selo.title=T(`Agora em Pinheiros (Open-Meteo, ${C_.hora.slice(11)}): sensação ${Math.round(C_.sensacao)}°, umidade ${C_.umidade}%, vento ${Math.round(C_.vento_kmh)} km/h`,
      `Now in Pinheiros (Open-Meteo, ${C_.hora.slice(11)}): feels like ${Math.round(C_.sensacao)}°, humidity ${C_.umidade}%, wind ${Math.round(C_.vento_kmh)} km/h`);
    selo.hidden=false; chuva.visible=!semMovimento&&C_.chuva_mm>0;
  }
  aoTrocarIdioma.push(()=>{ if(C_) clima(); for(const q of estacoes.values()) q.el.setAttribute("aria-label",`${q.e.n}: ${q.e.b} ${T("bicicletas livres","bikes available")}`); });
  clima(); setInterval(()=>{ if(visivel()) clima(); },10*60e3);
  if(verBike) bike(); if(verAv) voos();

  return { quadro(dt,agora){
    if(verBike&&visivel()&&agora-tBike>60e3) bike();
    if(verAv&&visivel()&&agora-tAv>10e3) voos();
    if(verTr&&visivel()&&agora-tTr>5*60e3) transitoCarrega();
    const dCam=camera.position.distanceTo(controls.target);
    for(const q of estacoes.values()){
      const ok=verBike&&(rua.ativo?q.pos.distanceTo(camera.position)<350:dCam<1600)&&projeta(q.pos,q.el);
      q.el.style.display=ok?"":"none";
    }
    for(const q of incidentes){
      const ok=verTr&&(rua.ativo?q.pos.distanceTo(camera.position)<350:dCam<1800)&&projeta(q.pos,q.el);
      q.el.style.display=ok?"":"none";
    }
    for(const q of avioes.values()){
      const a=q.a, r=(a.rumo??0)*Math.PI/180;
      if(!semMovimento){ q.alvo.x+=Math.sin(r)*a.vel*dt; q.alvo.z-=Math.cos(r)*a.vel*dt; q.alvo.y+=a.sobe*dt; }
      q.pos.lerp(q.alvo,Math.min(1,dt*1.5)); q.m.position.copy(q.pos); q.m.rotation.y=-r;
      q.el.style.display=verAv&&projeta(q.pos,q.el,40)?"":"none";
    }
    if(chuva.visible){ const a=chuva.geometry.attributes.position, v=a.array;
      for(let i=1;i<v.length;i+=3){ v[i]-=dt*220; if(v[i]<0) v[i]+=700; } a.needsUpdate=true;
      chuva.position.set(camera.position.x,Math.max(0,camera.position.y-500),camera.position.z); }
  } };
})();

// ---------- estilos de lente (pós-processamento): visão noturna, térmica, noir e CRT ----------
const estilos=(()=>{
  const rt=new THREE.WebGLRenderTarget(2,2,{samples:MODESTO?0:4});
  rt.texture.colorSpace=THREE.SRGBColorSpace;
  const mat=new THREE.ShaderMaterial({uniforms:{tex:{value:rt.texture},modo:{value:0},t:{value:0},res:{value:new THREE.Vector2(1,1)}},
    vertexShader:"varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }",
    fragmentShader:`uniform sampler2D tex; uniform int modo; uniform float t; uniform vec2 res; varying vec2 vUv;
      float rnd(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233))+t)*43758.5453); }
      vec3 ferro(float x){   // "ironbow": azul-escuro → roxo → vermelho → laranja → amarelo → branco
        vec3 a=mix(vec3(.02,.01,.12),vec3(.45,.05,.55),smoothstep(0.,.3,x)); a=mix(a,vec3(.9,.15,.15),smoothstep(.25,.5,x));
        a=mix(a,vec3(1.,.55,.05),smoothstep(.45,.7,x)); a=mix(a,vec3(1.,.92,.3),smoothstep(.65,.88,x)); return mix(a,vec3(1.),smoothstep(.88,1.,x)); }
      void main(){
        vec2 uv=vUv; vec3 c=texture2D(tex,uv).rgb; float l=dot(c,vec3(.299,.587,.114)); float v=1.-smoothstep(.45,.95,length(uv-.5)*1.25);
        vec3 o=c;
        if(modo==1){ float g=pow(l,.7)*1.35+(rnd(uv*res)-.5)*.16; o=vec3(.12,1.,.25)*g*v; }
        else if(modo==2){ float x=clamp(pow(l,1.4)*1.15,0.,1.); o=ferro(x)*(.85+.15*v); }
        else if(modo==3){ float g=smoothstep(.0,.85,pow(l,.8)); g=g*g*(3.-2.*g); o=vec3(g+(rnd(uv*res)-.5)*.08)*(.55+.45*v); }
        else if(modo==4){ vec2 d=vec2(1.5/res.x,0.); o=vec3(texture2D(tex,uv+d).r,c.g,texture2D(tex,uv-d).b);
          o*=.82+.18*sin(uv.y*res.y*1.6); o=pow(o,vec3(.9))*vec3(.95,1.05,.98)*(.6+.4*v)+.03*(rnd(vec2(t))-.5); }
        gl_FragColor=vec4(o,1.);
      }`,depthTest:false,depthWrite:false});
  const quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat), cenaQ=new THREE.Scene(), camQ=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  quad.frustumCulled=false; cenaQ.add(quad);
  const NOMES=["normal","nvg","termica","noir","crt"];
  let modo=0;
  const seg=document.getElementById("segEstilo");
  function liga(m){ modo=Math.max(0,NOMES.indexOf(m)); mat.uniforms.modo.value=modo; palco.classList.toggle("lente",modo>0);
    seg.querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.e===NOMES[modo]));
    try{ localStorage.setItem("bairro3d-estilo",NOMES[modo]); }catch(e){} }
  seg.addEventListener("click",e=>{ const b=e.target.closest("button[data-e]"); if(b) liga(b.dataset.e); });
  try{ liga(localStorage.getItem("bairro3d-estilo")||"normal"); }catch(e){ liga("normal"); }
  return { liga, get nome(){ return NOMES[modo]; },
    render(agora){
      if(!modo){ renderer.render(scene,camera); return; }
      const s=renderer.getDrawingBufferSize(new THREE.Vector2());
      if(rt.width!==s.x||rt.height!==s.y){ rt.setSize(s.x,s.y); mat.uniforms.res.value.copy(s); }
      mat.uniforms.t.value=semMovimento?0:(agora/1000)%100;
      renderer.setRenderTarget(rt); renderer.render(scene,camera); renderer.setRenderTarget(null); renderer.render(cenaQ,camQ);
    } };
})();

// ---------- link compartilhável: câmera, camadas ao vivo, noite e lente vão no endereço (#v=…&c=…&e=…) ----------
const LINK=(()=>{ const h=new URLSearchParams(location.hash.slice(1)); return {v:h.get("v"),c:h.has("c")?h.get("c").split(",").filter(Boolean):null,e:h.get("e")}; })();
function linkAtual(){
  const r=v=>Math.round(v), p=camera.position, a=controls.target;
  const c=[["bike","btBike"],["avioes","btAvioes"],["transito","btTransito"],["orto","btOrto"],["noite","btNoite"]].filter(([,id])=>document.getElementById(id)?.getAttribute("aria-pressed")==="true").map(([k])=>k);
  const h=new URLSearchParams({v:[p.x,p.y,p.z,a.x,a.y,a.z].map(r).join(","),c:c.join(",")}); if(estilos.nome!=="normal") h.set("e",estilos.nome);
  return location.origin+location.pathname+location.search+"#"+h.toString().replace(/%2C/g,",");
}
{ const bt=document.getElementById("btLink");
  bt.onclick=async()=>{ const u=linkAtual(); history.replaceState(null,"",u);
    let ok=false; try{ await navigator.clipboard.writeText(u); ok=true; }catch(e){}
    if(navigator.share&&matchMedia("(pointer:coarse)").matches){ try{ await navigator.share({title:document.title,url:u}); return; }catch(e){} }
    const t=bt.innerHTML; bt.innerHTML=ok?L("Link copiado","Link copied"):L("Link no endereço","Link in address bar"); setTimeout(()=>bt.innerHTML=t,1800); }; }
if(LINK.v){ const n=LINK.v.split(",").map(Number); if(n.length===6&&n.every(Number.isFinite)){ camera.position.set(n[0],n[1],n[2]); controls.target.set(n[3],n[4],n[5]); anim=null; } }
if(LINK.e) estilos.liga(LINK.e);
if(LINK.c){ const quer=new Set(LINK.c); if(quer.has("noite")!==noiteAtual) modo(quer.has("noite"));
  for(const [k,id] of [["bike","btBike"],["avioes","btAvioes"],["transito","btTransito"],["orto","btOrto"]]){ const b=document.getElementById(id); if(b&&!b.hidden&&(b.getAttribute("aria-pressed")==="true")!==quer.has(k)) b.click(); } }

// ---------- notícias de Pinheiros (Google News, últimos 7 dias); quando citam um lugar do mapa, dá para voar até ele ----------
{ const lista=document.getElementById("noticiasLista");
  const nomes=[...(A?.lugares||[]).filter(p=>p.n&&Math.hypot(p.x,p.y)<B.meta.anel_m).map(p=>({n:p.n,x:p.x,y:p.y})),
    ...lugares.map(q=>({n:q.l.n,x:q.l.x,y:q.l.y}))].filter(l=>l.n.length>=10).sort((a,b)=>b.n.length-a.n.length);   // "Pinheiros" sozinho casaria com tudo
  const sem=t=>t.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
  const quando=t=>{ const h=(Date.now()/1000-t)/3600; return h<1?L("agora há pouco","just now"):h<24?L(`há ${Math.round(h)} h`,`${Math.round(h)} h ago`):L(`há ${Math.round(h/24)} d`,`${Math.round(h/24)} d ago`); };
  fetch("api/noticias").then(r=>r.ok?r.json():null).catch(()=>null).then(D=>{
    if(!D||!D.noticias.length) return;
    const itens=D.noticias.map(n=>({...n,lugar:nomes.find(l=>sem(n.t).includes(sem(l.n)))}));
    lista.innerHTML=itens.map((n,i)=>`<div class="noticia"><a href="${esc(n.u)}" target="_blank" rel="noopener nofollow"><b>${esc(n.t)}</b></a>
      <span>${esc(n.f)} · ${quando(n.q)}${n.lugar?` · <button type="button" class="sec" data-i="${i}">${L("ver no mapa","show on map")}: ${esc(n.lugar.n)}</button>`:""}</span></div>`).join("");
    lista.onclick=e=>{ const b=e.target.closest("button[data-i]"); if(!b) return; const l=itens[+b.dataset.i].lugar, h=alturaEm(l.x,l.y), alvo=new THREE.Vector3(l.x,h,-l.y);
      const d=camera.position.clone().sub(controls.target).setY(0).normalize(); voarPara(alvo.clone().add(d.multiplyScalar(320)).setY(h+240),alvo);
      setTimeout(()=>abrirBalao(alvo.clone().setY(h+12),`<b>${esc(l.n)}</b><p>${esc(itens[+b.dataset.i].t)}</p>`),1450); palco.scrollIntoView({behavior:"smooth",block:"center"}); };
    document.getElementById("cartaoNoticias").hidden=false;
  });
}

// ---------- diretor de cena: passeio de câmera pronto (e gravação do canvas em vídeo, sem os botões) ----------
const diretor=(()=>{
  const btP=document.getElementById("btPasseio"), btG=document.getElementById("btGravar");
  const V3=(x,y,z)=>new THREE.Vector3(x,y,z), alto=(x,z)=>hZ(x,z);
  // pontos do roteiro: chegada do alto, rasante, volta em torno do centro e os três lugares conhecidos mais perto; termina no bairro todo
  function roteiro(){
    const [p0,a0]=CAMS[0][1](), [p1,a1]=CAMS[1][1](), [p3,a3]=CAMS[3][1](), s=[];
    s.push({p:V3(420,1700,-260),a:C.clone(),d:0},{p:p0,a:a0,d:4500},{p:p1,a:a1,d:4500});
    s.push({orbita:{r:340,h:170,de:Math.atan2(p1.x,p1.z),graus:200},a:V3(0,30,0),d:9000});
    const perto=lugares.filter(q=>q.l.m>250&&q.l.m<1600&&q.l.t!=="metro"&&q.l.t!=="trem").sort((a,b)=>a.l.m-b.l.m).slice(0,3);
    for(const q of perto){ const t=q.pos.clone(), d=t.clone().setY(0).normalize(); s.push({p:t.clone().add(d.multiplyScalar(380)).setY(t.y+260),a:t,d:4200}); }
    s.push({p:p3,a:a3,d:5000});
    return s;
  }
  let ativo=null, gravador=null;
  const ui=on=>{ palco.classList.toggle("gravando",on); };
  function para(){ if(!ativo) return; ativo=null; ui(false); controls.enabled=true; btP.setAttribute("aria-pressed",false);
    if(gravador&&gravador.state!=="inactive") gravador.stop(); }
  function toca(gravar){
    if(ativo){ para(); return; }
    fecharBalao(); fechaCartoes?.(); document.getElementById("filtros").hidden=true; document.getElementById("btFiltros").setAttribute("aria-expanded",false);
    const s=roteiro(); let i=1, t0=performance.now(), de={p:camera.position.clone(),a:controls.target.clone()};
    camera.position.copy(s[0].p); controls.target.copy(s[0].a); de={p:s[0].p.clone(),a:s[0].a.clone()};
    ativo={s,i,t0,de}; anim=null; controls.enabled=false; btP.setAttribute("aria-pressed",true); ui(true);
    if(gravar){
      const tipo=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4"].find(t=>MediaRecorder.isTypeSupported?.(t));
      if(!tipo||!renderer.domElement.captureStream){ alert(T("Este navegador não grava vídeo do canvas.","This browser cannot record the canvas.")); para(); return; }
      const pedacos=[]; gravador=new MediaRecorder(renderer.domElement.captureStream(30),{mimeType:tipo,videoBitsPerSecond:12e6});
      gravador.ondataavailable=e=>{ if(e.data.size) pedacos.push(e.data); };
      gravador.onstop=()=>{ const b=new Blob(pedacos,{type:tipo}), a=document.createElement("a");
        a.href=URL.createObjectURL(b); a.download=`bairro3d-passeio.${tipo.includes("mp4")?"mp4":"webm"}`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(a.href),60e3); gravador=null; };
      gravador.start(1000);
    }
  }
  btP.onclick=()=>toca(false); btG.onclick=()=>toca(true);
  addEventListener("keydown",e=>{ if(e.key==="Escape") para(); });
  renderer.domElement.addEventListener("pointerdown",()=>{ if(ativo&&!gravador) para(); });
  if(!window.MediaRecorder||!renderer.domElement.captureStream) btG.hidden=true;
  return { quadro(agora){
    if(!ativo) return;
    const q=ativo.s[ativo.i], t=Math.min(1,(agora-ativo.t0)/q.d), k=ease(t);
    if(q.orbita){ const o=q.orbita, ang=o.de+(o.graus*Math.PI/180)*k, alvoPos=V3(Math.sin(ang)*o.r,0,Math.cos(ang)*o.r);
      alvoPos.y=Math.max(o.h,alto(alvoPos.x,alvoPos.z)+40);
      const entra=Math.min(1,t*4); camera.position.lerpVectors(ativo.de.p,alvoPos,entra<1?ease(entra):1); controls.target.lerpVectors(ativo.de.a,q.a,ease(Math.min(1,t*3)));
      if(entra>=1) camera.position.copy(alvoPos); }
    else { camera.position.lerpVectors(ativo.de.p,q.p,k); controls.target.lerpVectors(ativo.de.a,q.a,k); }
    camera.lookAt(controls.target);
    if(t>=1){ ativo.de={p:camera.position.clone(),a:controls.target.clone()}; ativo.i++; ativo.t0=agora; if(ativo.i>=ativo.s.length) para(); }
  }, get ativo(){ return !!ativo; } };
})();

// ---------- fotos da rua (Mapillary): com o modo ligado, toque num ponto do mapa e veja a foto de rua mais perto ----------
const fotosRua=(()=>{
  const bt=document.getElementById("btFotos"), cartao=document.getElementById("cartaoFoto"), corpo=cartao.querySelector(".corpo");
  const kx=B.meta.m_por_grau.lon, ky=B.meta.m_por_grau.lat, o=B.meta.origem, rc=new THREE.Raycaster(), m2=new THREE.Vector2();
  const seta=new THREE.Mesh(new THREE.ConeGeometry(5,14,16).rotateX(Math.PI/2).translate(0,0,-7),new THREE.MeshBasicMaterial({color:0x0ea5e9,transparent:true,opacity:.85,depthTest:false}));
  seta.visible=false; seta.renderOrder=5; scene.add(seta);
  let ativo=false, lista=[], i=0, pedido=0;
  const data=q=>new Date(q*1000).toLocaleDateString(EN()?"en-GB":"pt-BR",{month:"short",year:"numeric"});
  function mostra(){
    const f=lista[i]; if(!f){ seta.visible=false; return; }
    const x=(f.lon-o.lon)*kx, y=(f.lat-o.lat)*ky; seta.position.set(x,hZ(x,-y)+3,-y); seta.rotation.y=-(f.ang||0)*Math.PI/180; seta.visible=true;
    corpo.innerHTML=`<a href="https://www.mapillary.com/app/?pKey=${f.id}" target="_blank" rel="noopener"><img src="api/foto/${f.id}.jpg" alt="${T("Foto de rua","Street photo")}" loading="lazy"></a>
      <div class="lin"><span>${data(f.q)} · ${dist(f.m)} ${L("do ponto","from the point")}${f.pano?" · 360°":""}</span>
      ${lista.length>1?`<span class="nav"><button type="button" data-d="-1" aria-label="${T("Anterior","Previous")}">‹</button>${i+1}/${lista.length}<button type="button" data-d="1" aria-label="${T("Próxima","Next")}">›</button></span>`:""}</div>
      <p class="mt">© ${esc(f.autor||"Mapillary")} · <a href="https://www.mapillary.com/app/?pKey=${f.id}" target="_blank" rel="noopener">Mapillary</a>, CC BY-SA 4.0</p>`;
  }
  corpo.addEventListener("click",e=>{ const b=e.target.closest("button[data-d]"); if(!b) return; i=(i+(+b.dataset.d)+lista.length)%lista.length; mostra(); });
  async function em(x,y){
    const n=++pedido; cartao.hidden=false; corpo.innerHTML=`<p>${L("Procurando fotos de rua aqui…","Looking for street photos here…")}</p>`;
    const lat=o.lat+y/ky, lon=o.lon+x/kx;
    const D=await fetch(`api/foto?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`).then(r=>r.ok?r.json():null).catch(()=>null);
    if(n!==pedido) return;
    lista=D?.fotos||[]; i=0;
    if(!lista.length){ seta.visible=false; corpo.innerHTML=`<p>${L("Nenhuma foto de rua a menos de 60 m daqui. Tente perto de uma avenida.","No street photos within 60 m. Try near a main road.")}</p>`; return; }
    mostra();
  }
  function liga(v){ ativo=v; bt.setAttribute("aria-pressed",v); palco.classList.toggle("modoFoto",v); if(!v){ cartao.hidden=true; seta.visible=false; }
    else{ cartao.hidden=false; corpo.innerHTML=`<p>${L("Toque num ponto do mapa para ver a foto de rua mais perto.","Tap a point on the map to see the nearest street photo.")}</p>`; } }
  bt.onclick=()=>liga(!ativo);
  document.getElementById("fotoFechar").onclick=()=>liga(false);
  return { clique(e){
    if(!ativo) return false;
    const r=renderer.domElement.getBoundingClientRect(); m2.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1); rc.setFromCamera(m2,camera);
    const hit=rc.intersectObjects([chao,...malhasPredios],false)[0]; if(!hit) return true;
    em(hit.point.x,-hit.point.z); return true;
  } };
})();

// ---------- ônibus: GPS ao vivo (SPTrans Olho Vivo). Cada ônibus manda posição a cada ~40 s; a maquete mostra o trajeto com
// ATRASO de 1 min, andando pelo traçado da linha (GTFS) entre uma leitura e a seguinte, sem parar nem cortar quarteirão.
// Sem GPS (API fora), cai na grade programada: cada linha anda no seu traçado conforme a hora de agora ----------
const onibus=(()=>{
  const bt=document.getElementById("btOnibus"), MAX=700;
  // modelinho low-poly de ônibus urbano (12,4 × 2,5 × 3 m, frente em +z): a carroceria leva a cor da linha (cor por
  // instância); janelas, para-brisa, teto, rodas e faróis são uma segunda malha com as mesmas posições e cores fixas
  const caixa=(w,h,l,x,y,z,c)=>{ const g=new THREE.BoxGeometry(w,h,l).toNonIndexed(); g.translate(x,y,z); const k=new THREE.Color(c), n=g.attributes.position.count, a=new Float32Array(n*3);
    for(let i=0;i<n;i++) a.set([k.r,k.g,k.b],i*3); g.setAttribute("color",new THREE.BufferAttribute(a,3)); g.deleteAttribute("uv"); return g; };
  const geoCorpo=mergeGeometries([caixa(2.5,1.05,12.4,0,.95,0,0xffffff),caixa(2.5,.32,12.4,0,2.62,0,0xffffff),
    ...[-5.4,-3.6,-1.8,0,1.8,3.6,5.4].flatMap(z=>[caixa(.05,1.1,.16,1.285,1.97,z,0xffffff),caixa(.05,1.1,.16,-1.285,1.97,z,0xffffff)])]);   // colunas entre as janelas
  const geoDet=mergeGeometries([
    caixa(2.56,1.1,11.9,0,1.97,-.15,0x1f2b38),          // faixa de janelas
    caixa(2.3,1.25,.12,0,1.9,6.2,0x26394d),             // para-brisa
    caixa(2.3,.5,.08,0,2.6,6.21,0x111111),              // letreiro
    caixa(2.2,.28,5,0,2.92,-1,0xe9ecef),                // ar-condicionado no teto
    caixa(2.62,.75,1.05,0,.42,4.1,0x1a1a1a), caixa(2.62,.75,1.05,0,.42,-3.6,0x1a1a1a),   // rodas (eixos)
    caixa(.45,.22,.06,.85,.75,6.22,0xfff6d5), caixa(.45,.22,.06,-.85,.75,6.22,0xfff6d5), // faróis
    caixa(.4,.25,.06,.9,.9,-6.22,0xd8352a), caixa(.4,.25,.06,-.9,.9,-6.22,0xd8352a),      // lanternas
  ]);
  const im=new THREE.InstancedMesh(geoCorpo,new THREE.MeshLambertMaterial({vertexColors:true}),MAX);
  const imDet=new THREE.InstancedMesh(geoDet,new THREE.MeshLambertMaterial({vertexColors:true}),MAX);
  for(const m of [im,imDet]){ m.count=0; m.frustumCulled=false; m.visible=false; scene.add(m); }
  imDet.raycast=()=>{};
  const cor=new THREE.Color(), mx=new THREE.Matrix4(), q=new THREE.Quaternion(), up=new THREE.Vector3(0,1,0), escala=new THREE.Vector3(1,1,1), pos=new THREE.Vector3();
  let D=null, pD=null, ativo=false, quem=[], onde=[];   // quem/onde: ônibus e posição de cada instância desenhada (para o clique)
  // gps: Map prefixo → {l,d,cor,ang,fixes:[{t,x,y,seg}]}; null = ainda não respondeu; gpsFalhou = API fora, usa a grade
  let gps=null, gpsFalhou=false, timer=0, relogio=null;   // relogio: [hora da leitura mais nova (ms), performance.now() ao receber]
  const porLinha=new Map(), kx=B.meta.m_por_grau.lon, ky=B.meta.m_por_grau.lat, org=B.meta.origem, ATRASO=60000;
  try{ ativo=localStorage.getItem("bairro3d-onibus")==="1"; }catch(e){}
  const agoraSP=()=>{ const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/Sao_Paulo",hour12:false,weekday:"short",hour:"2-digit",minute:"2-digit",second:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
    return {dia:["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].indexOf(p.weekday),s:(+p.hour%24)*3600+(+p.minute)*60+(+p.second)+(Date.now()%1000)/1000}; };
  function carrega(){
    return pD||(pD=pegar("onibus.json").then(d=>{ D=d; if(!D) return;
      for(const v of D.viagens){ const n=v.p.length/2; v.ac=[0]; for(let i=1;i<n;i++) v.ac.push(v.ac[i-1]+Math.hypot(v.p[2*i]-v.p[2*i-2],v.p[2*i+1]-v.p[2*i-1])); v.cor=new THREE.Color(v.c);
        if(!porLinha.has(v.r)) porLinha.set(v.r,[]); porLinha.get(v.r).push(v); } }));
  }
  function projeta(v,x,y){   // [distância² ao traçado, metros desde o início do traçado] do ponto mais perto
    const p=v.p; let dm=Infinity, sm=0;
    for(let i=0;i<p.length-2;i+=2){ const ax=p[i], ay=p[i+1], dx=p[i+2]-ax, dy=p[i+3]-ay, L2=dx*dx+dy*dy||1;
      const f=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/L2)), ex=ax+dx*f-x, ey=ay+dy*f-y, d=ex*ex+ey*ey;
      if(d<dm){ dm=d; sm=v.ac[i/2]+f*(v.ac[i/2+1]-v.ac[i/2]); } }
    return [dm,sm];
  }
  function trecho(l,a,b){   // a→b andando por um traçado da linha no sentido certo (os dois a até 35 m dele), ou null
    let melhor=null, dm=35*35;
    for(const v of porLinha.get(l)||[]){
      const [da,sa]=projeta(v,a.x,a.y), [db,sb]=projeta(v,b.x,b.y);
      if(da<dm&&db<35*35&&sb>=sa-5&&sb-sa<2500){ dm=da; melhor={v,s0:sa,s1:Math.max(sa,sb)}; } }
    return melhor;
  }
  function ponto(v,dd){   // posição e direção a dd metros do início do trecho
    let lo=0, hi=v.ac.length-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(v.ac[m]<=dd) lo=m; else hi=m; }
    const f=(dd-v.ac[lo])/Math.max(.01,v.ac[hi]-v.ac[lo]), x0=v.p[2*lo], y0=v.p[2*lo+1], x1=v.p[2*hi], y1=v.p[2*hi+1];
    return [x0+(x1-x0)*f,y0+(y1-y0)*f,Math.atan2(x1-x0,-(y1-y0))];
  }
  async function lerGps(){
    clearTimeout(timer); if(!ativo) return;
    if(document.visibilityState==="visible"){
      await carrega();
      const R=await fetch(`api/onibus?lat=${org.lat}&lon=${org.lon}`).then(r=>r.ok?r.json():null).catch(()=>null);
      if(R){
        gpsFalhou=false; const novo=new Map(); let maisNova=0;
        for(const o of R.onibus){
          const t=Date.parse(o.ta); if(!Number.isFinite(t)) continue; maisNova=Math.max(maisNova,t);
          const a=gps?.get(o.p)||{l:o.l,d:o.d,ang:null,fixes:[],cor:new THREE.Color(porLinha.get(o.l)?.[0]?.c||"#2563eb")};
          a.d=o.d;
          for(const [la,lo,ta] of [...(a.fixes.length?[]:o.h||[]),[o.lat,o.lon,o.ta]]){   // ônibus novo: entra com as leituras anteriores
            const tt=Date.parse(ta), F=a.fixes, ult=F[F.length-1]; if(!Number.isFinite(tt)||(ult&&tt<=ult.t)) continue;
            const fx={t:tt,x:(lo-org.lon)*kx,y:(la-org.lat)*ky,seg:null};
            if(ult&&(Math.hypot(fx.x-ult.x,fx.y-ult.y)>800||tt-ult.t>300000)) F.length=0;   // pulo (GPS voltou, garagem): recomeça
            else if(ult) fx.seg=trecho(o.l,ult,fx);
            F.push(fx); while(F.length>5) F.shift();
          }
          novo.set(o.p,a);
        }
        gps=novo; if(maisNova) relogio=[maisNova,performance.now()];
      } else if(!gps) gpsFalhou=true;
    }
    timer=setTimeout(lerGps,15000);
  }
  function naHora(o,T){   // [x,y,ângulo ou null] do ônibus no instante T (ms, relógio da SPTrans)
    const F=o.fixes; if(T<=F[0].t) return [F[0].x,F[0].y,null];
    for(let k=1;k<F.length;k++){ const a=F[k-1], b=F[k]; if(T>b.t) continue;
      const f=(T-a.t)/Math.max(1,b.t-a.t);
      if(b.seg) return ponto(b.seg.v,b.seg.s0+(b.seg.s1-b.seg.s0)*f);
      const dx=b.x-a.x, dy=b.y-a.y; return [a.x+dx*f,a.y+dy*f,Math.hypot(dx,dy)>3?Math.atan2(dx,-dy):null]; }
    const z=F[F.length-1]; return [z.x,z.y,null];
  }
  function desenha(x,y,ang,c,quemE,n){   // ang = atan2(dx leste, dz da cena): mesma convenção dos trens (rotation.y)
    pos.set(x,hZ(x,-y)+.15,-y); q.setFromAxisAngle(up,ang); mx.compose(pos,q,escala);
    im.setMatrixAt(n,mx); imDet.setMatrixAt(n,mx); im.setColorAt(n,cor.copy(c)); quem[n]=quemE; onde[n]=pos.clone();
  }
  function quadro(){
    if(!ativo) return;
    let n=0; quem=[]; onde=[];
    escala.setScalar(Math.min(2.2,Math.max(1,camera.position.distanceTo(controls.target)/700)));   // de longe, um pouco maiores
    if(gps&&relogio){
      const T=relogio[0]+(performance.now()-relogio[1])-ATRASO;
      for(const o of gps.values()){
        if(n>=MAX) break;
        const [x,y,ang]=naHora(o,T); if(ang!=null) o.ang=ang;
        if(Math.hypot(x,y)>=B.meta.anel_m) continue;
        desenha(x,y,o.ang??0,o.cor,o,n++);
      }
    } else if(gpsFalhou&&D){
      const {dia,s}=agoraSP();
      for(const v of D.viagens){
        if(!(D.dias[v.s]||[])[dia]) continue;
        const fim=v.t[v.t.length-1];
        for(const [ini,ate,h] of v.f){
          for(const S of [s,s+86400]){   // viagens que começaram antes da meia-noite
            const e0=S-v.o-fim, e1=S-v.o;   // a viagem começou (no ponto inicial) entre e0 e e1 para estar no trecho agora
            let k=Math.max(0,Math.ceil((e0-ini)/h)), st;
            while((st=ini+k*h)<=Math.min(ate,e1)&&n<MAX){
              const el=S-v.o-st; let j=0; while(j<v.t.length-2&&v.t[j+1]<el) j++;
              const dd=v.d[j]+(v.d[j+1]-v.d[j])*Math.min(1,Math.max(0,(el-v.t[j])/Math.max(1,v.t[j+1]-v.t[j])));
              const [x,y,ang]=ponto(v,dd);
              if(Math.hypot(x,y)<B.meta.anel_m) desenha(x,y,ang,v.cor,v,n++);
              k++;
            }
          }
        }
      }
    }
    im.count=imDet.count=n; im.instanceMatrix.needsUpdate=imDet.instanceMatrix.needsUpdate=true; if(im.instanceColor) im.instanceColor.needsUpdate=true;
    im.boundingSphere=null;   // os ônibus andam: a esfera de limites do clique é refeita no próximo raycast
  }
  function liga(v){ ativo=v; bt.setAttribute("aria-pressed",v); im.visible=imDet.visible=v; try{ localStorage.setItem("bairro3d-onibus",v?"1":"0"); }catch(e){} if(v) lerGps(); else clearTimeout(timer); }
  bt.onclick=()=>liga(!ativo); liga(ativo);
  const rc=new THREE.Raycaster(), m2=new THREE.Vector2(), w=new THREE.Vector3();
  return { quadro, get n(){ return im.count; }, clique(e){
    if(!ativo||!im.count) return false;
    const r=renderer.domElement.getBoundingClientRect(); m2.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1); rc.setFromCamera(m2,camera);
    let i=rc.intersectObject(im,false)[0]?.instanceId;
    if(i==null){   // ônibus é pequeno de longe: vale o mais perto do toque, até 18 px
      let dm=18*18;
      for(let k=0;k<onde.length;k++){ w.copy(onde[k]).project(camera); if(w.z>1) continue;
        const dx=(w.x+1)/2*r.width-(e.clientX-r.left), dy=(1-w.y)/2*r.height-(e.clientY-r.top), d=dx*dx+dy*dy; if(d<dm){ dm=d; i=k; } }
    }
    const v=i==null?null:quem[i]; if(!v) return false;
    const alvo=onde[i].clone().setY(onde[i].y+6);
    if(v.fixes) abrirBalao(alvo,`<b>${esc(v.l)} · ${esc(v.d)}</b><div class="tipo"><i style="background:#${v.cor.getHexString()}"></i>${L("Ônibus","Bus")}</div>
        <p>${L("GPS ao vivo da SPTrans (Olho Vivo). O ônibus anda com cerca de 1 min de atraso, pelo traçado da linha entre uma leitura e a seguinte.","Live SPTrans GPS (Olho Vivo). Buses play back about 1 min behind, following the route between one reading and the next.")}</p>`);
    else abrirBalao(alvo,`<b>${esc(v.r)} · ${esc(v.n)}</b><div class="tipo"><i style="background:${esc(v.c)}"></i>${L("Ônibus","Bus")}</div>
      <p>${L("Posição pela grade programada da SPTrans (GTFS): o GPS está fora do ar agora.","Position from the SPTrans timetable (GTFS): the GPS feed is down right now.")}</p>`);
    return true;
  } };
})();

let tAnt=performance.now();
// resolução adaptativa: a cada 2 s olha o tempo médio de quadro; abaixo de ~45 qps baixa 0,25 no pixelRatio (até 1) e
// não volta mais acima do que ficou lento; folgado (no vsync) por 6 s seguidos, sobe de novo até o máximo do aparelho
const DPR_MAX=renderer.getPixelRatio(); let dpr=DPR_MAX, dprTeto=DPR_MAX, qSoma=0, qN=0, qBom=0, tQ=performance.now(), tSombra=0, tRot=0;
const camAnt=new THREE.Matrix4();
function adapta(agora,ms){
  if(ms<250&&agora-tMexeu<1500){ qSoma+=ms; qN++; }   // só mede com a câmera mexendo (parado roda a 30 de propósito)
  if(agora-tQ<2000||qN<20) return;
  const med=qSoma/qN; qSoma=qN=0; tQ=agora;
  if(med>22&&dpr>1){ dprTeto=dpr-.25; dpr=Math.max(1,dprTeto); renderer.setPixelRatio(dpr); qBom=0; }
  else if(med<17.5&&dpr<dprTeto){ if(++qBom>=3){ dpr=Math.min(dprTeto,dpr+.25); renderer.setPixelRatio(dpr); qBom=0; } }
  else qBom=0;
}
let tMexeu=performance.now(), tDesenho=0;
controls.addEventListener("start",()=>{ tMexeu=performance.now(); }); controls.addEventListener("change",()=>{ tMexeu=performance.now(); });
palco.addEventListener("pointerdown",()=>{ tMexeu=performance.now(); },{passive:true});
addEventListener("resize",()=>{ tMexeu=performance.now(); });   // redimensionar apaga o canvas: redesenha já
function quadro(){
  const t=performance.now();
  if(t-tMexeu>1500&&!anim&&!rua.ativo&&!diretor.ativo&&t-tDesenho<30) return;   // parado: ~30 qps bastam
  tDesenho=t;
  const agora=t, ms=agora-tAnt, dt=Math.min(.1,ms/1000); tAnt=agora;
  adapta(agora,ms);
  if(agora-tSombra>500){ tSombra=agora; sombraJa(); }
  solQuadro(agora); camadasQuadro(); chunks.quadro(agora); futuroQuadro(agora);
  if(carros&&!semMovimento) carros.passo(dt);
  rua.quadro(dt);
  aoVivo.quadro(dt,agora); if(!semMovimento) onibus.quadro();
  if(anim){
    const t=Math.max(0,Math.min(1,(agora-anim.t0)/anim.dur)), k=ease(t);
    camera.position.lerpVectors(anim.p0,anim.p1,k); controls.target.lerpVectors(anim.a0,anim.a1,k);
    if(t>=1) anim=null;
  }
  diretor.quadro(agora);
  if(!rua.ativo&&!diretor.ativo) controls.update();
  estilos.render(agora);
  rotulo.style.display=!rua.ativo&&projeta(topoC,rotulo,64)?"":"none";
  const moveu=!camAnt.equals(camera.matrixWorld); if(moveu) camAnt.copy(camera.matrixWorld);
  const rotulos=moveu||agora-tRot>200; if(rotulos) tRot=agora;
  if(rotulos){ // postos: só de perto (câmera a menos de ~1,6 km do alvo); os sem preço, só bem perto
    const dCam=camera.position.distanceTo(controls.target);
    for(const q of postos){
      const ok=verPostos&&(rua.ativo?q.pos.distanceTo(camera.position)<350:dCam<(q.p.g!=null?1600:700))&&projeta(q.pos,q.el);
      q.el.style.display=ok?"":"none";
    }
  }
  if(rotulos){ const dCam=camera.position.distanceTo(controls.target);
    for(const q of marcadores){
      const ok=!q.oculto&&(rua.ativo?q.pos.distanceTo(camera.position)<350:dCam<q.perto)&&projeta(q.pos,q.el);
      q.el.style.display=ok?"":"none"; q.vis=ok;
    }
    // lugares conhecidos: sem pílulas encavaladas (os lugares têm prioridade sobre as estações; mais perto da câmera primeiro)
    const vis=lugares.filter(q=>q.vis).sort((a,b)=>(a.l.t==="metro"||a.l.t==="trem")-(b.l.t==="metro"||b.l.t==="trem")||a.pos.distanceToSquared(camera.position)-b.pos.distanceToSquared(camera.position));
    const caixas=[];
    for(const q of vis){ const x=parseFloat(q.el.style.left), y=parseFloat(q.el.style.top), w=(q.w||(q.w=q.el.offsetWidth||120))/2+4;
      if(caixas.some(c=>Math.abs(c.x-x)<c.w+w&&Math.abs(c.y-y)<30)){ q.el.style.display="none"; continue; }
      caixas.push({x,y,w}); }
  }
  { const perto=camera.position.distanceTo(controls.target)<1400;   // de longe as lajes nem aparecem
    for(const l of lajesLOD) l.m.visible=perto&&Math.hypot(camera.position.x-l.c.x,camera.position.z-l.c.z)<(l.r||750); }
  ceuMesh.position.copy(camera.position); estrelas.position.copy(camera.position); passoTrens(agora);
  if(rotulos){ // nomes de rua: só perto (câmera a menos de ~650 m do alvo), no máximo 10, os mais próximos do centro da vista
    const dCam=camera.position.distanceTo(controls.target), vis=[];
    if(dCam<650) for(const it of nomesRua){ const d=it.pos.distanceTo(controls.target); if(d<Math.max(220,dCam*.8)) vis.push([d,it]); }
    vis.sort((a,b)=>a[0]-b[0]); const mostrar=new Set(vis.slice(0,10).map(v=>v[1])), ocupados=[];
    for(const it of nomesRua){
      let ok=mostrar.has(it);
      if(ok){ const w=it.pos.clone().project(camera); ok=w.z<1&&Math.abs(w.x)<.95&&w.y>-.9&&w.y<.8;
        if(ok){ const x=(w.x+1)/2*palco.clientWidth, y=(1-w.y)/2*palco.clientHeight;
          ok=ocupados.every(([ox,oy])=>Math.abs(ox-x)>110||Math.abs(oy-y)>18);   // não deixa um nome em cima do outro
          if(ok){ ocupados.push([x,y]); it.el.style.left=`${x}px`; it.el.style.top=`${y}px`; } } }
      it.el.hidden=!ok;
    }
  }
  if(balaoEm){
    const w=balaoEm.clone().project(camera);
    const fora=w.z>1||Math.abs(w.x)>1||Math.abs(w.y)>1;
    balao.style.visibility=fora?"hidden":"";
    if(!fora){ balao.style.left=`${Math.min(palco.clientWidth-150,Math.max(150,(w.x+1)/2*palco.clientWidth))}px`; balao.style.top=`${Math.max(balao.offsetHeight+20,(1-w.y)/2*palco.clientHeight)}px`; }   // não deixa sair por cima
  }
  { const d=camera.position.distanceTo(controls.target), lg=horizonte.pronto;   // com o entorno carregado, a neblina vai bem mais longe
    scene.fog.near=d+(lg?900:500); scene.fog.far=d+(lg?(noiteAtual?14000:30000):(noiteAtual?2600:3400)); }
  const az=Math.atan2(camera.position.x-controls.target.x,camera.position.z-controls.target.z);
  agulha.setAttribute("transform",`rotate(${-az*180/Math.PI} 15 15)`);
}
renderer.setAnimationLoop(quadro);
// maquete fora da tela (rolou para ler o resto da página): para de desenhar
new IntersectionObserver(([e])=>{ tAnt=tMexeu=performance.now(); renderer.setAnimationLoop(e.isIntersecting?quadro:null); }).observe(palco);

