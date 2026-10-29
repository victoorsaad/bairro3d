"""Leitor mínimo de Mapbox Vector Tile (protobuf), só o necessário para os tiles de trânsito da TomTom.

Devolve {camada: [(propriedades, [linha, ...]), ...]}, cada linha com pontos (x, y) na grade do tile (0..extent).
"""


def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def _campos(b):
    """(número do campo, tipo, valor) de uma mensagem protobuf."""
    i, n = 0, len(b)
    while i < n:
        k, i = _varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            ln, i = _varint(b, i)
            v, i = b[i:i + ln], i + ln
        elif t == 1:
            v, i = b[i:i + 8], i + 8
        elif t == 5:
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError("tipo protobuf %d" % t)
        yield f, t, v


def _empacotado(b):
    i, out = 0, []
    while i < len(b):
        v, i = _varint(b, i)
        out.append(v)
    return out


def _valor(b):
    import struct
    for f, t, v in _campos(b):
        if f == 1:
            return v.decode("utf-8", "replace")
        if f == 2:
            return struct.unpack("<f", v)[0]
        if f == 3:
            return struct.unpack("<d", v)[0]
        if f in (4, 5):
            return v
        if f == 6:
            return (v >> 1) ^ -(v & 1)
        if f == 7:
            return bool(v)
    return None


def _geometria(cmds):
    linhas, atual, x, y, i = [], [], 0, 0, 0
    zz = lambda v: (v >> 1) ^ -(v & 1)
    while i < len(cmds):
        c = cmds[i]
        i += 1
        op, n = c & 7, c >> 3
        if op in (1, 2):
            for _ in range(n):
                x += zz(cmds[i])
                y += zz(cmds[i + 1])
                i += 2
                if op == 1 and atual:
                    linhas.append(atual)
                    atual = []
                atual.append((x, y))
        elif op == 7 and atual:
            atual.append(atual[0])
    if atual:
        linhas.append(atual)
    return linhas


def ler(dados):
    camadas = {}
    for f, t, v in _campos(dados):
        if f != 3:
            continue
        nome, extent, chaves, valores, feats = "", 4096, [], [], []
        for g, _, w in _campos(v):
            if g == 1:
                nome = w.decode()
            elif g == 2:
                feats.append(w)
            elif g == 3:
                chaves.append(w.decode())
            elif g == 4:
                valores.append(_valor(w))
            elif g == 5:
                extent = w
        lista = []
        for fb in feats:
            tags, geo = [], []
            for g, _, w in _campos(fb):
                if g == 2:
                    tags = _empacotado(w)
                elif g == 4:
                    geo = _empacotado(w)
            props = {chaves[tags[k]]: valores[tags[k + 1]] for k in range(0, len(tags) - 1, 2)}
            lista.append((props, _geometria(geo)))
        camadas[nome] = (extent, lista)
    return camadas
