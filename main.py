"""
Bot Shopee -> WhatsApp + Supabase (versão otimizada)
----------------------------------------------------
- Busca geral/relevância da Shopee.
- Filtra: >= 1000 vendas e >= 4.5 estrelas.
- Processa página por página: não espera terminar toda a busca.
- Posta assim que encontra um produto válido e ainda não enviado.
- Usa Supabase como histórico permanente.
- Mantém servidor HTTP para Render/UptimeRobot.
"""

import os
import sys
import json
import time
import hashlib
import re
import unicodedata

import requests
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

# ===================== CONFIGURAÇÕES =====================

SHOPEE_APP_ID = os.getenv("SHOPEE_APP_ID")
SHOPEE_SECRET = os.getenv("SHOPEE_SECRET")
SHOPEE_AFFILIATE_ID = os.getenv("SHOPEE_AFFILIATE_ID")
SHOPEE_API_URL = os.getenv(
    "SHOPEE_API_URL",
    "https://open-api.affiliate.shopee.com.br/graphql"
)

WHATSAPP_ENABLED = os.getenv("WHATSAPP_ENABLED", "true").lower() == "true"
WHATSAPP_CHANNEL_NAME = os.getenv("WHATSAPP_CHANNEL_NAME", "Divulga Promos")
WHATSAPP_CHANNEL_LINK = os.getenv("WHATSAPP_CHANNEL_LINK", "")
# O Node usa a mesma PORT fornecida pelo Render.
# Se WHATSAPP_SERVICE_URL não for definida, o Python fala com o Node
# pela porta interna do próprio processo/container.
RENDER_PORT = os.getenv("PORT", "3333")
WHATSAPP_SERVICE_URL = os.getenv(
    "WHATSAPP_SERVICE_URL",
    f"http://127.0.0.1:{RENDER_PORT}"
).rstrip("/")
WHATSAPP_GROUP_ID = os.getenv("WHATSAPP_GROUP_ID", "")

SHOPEE_SEARCH_KEYWORD = os.getenv("SHOPEE_SEARCH_KEYWORD", "")
SHOPEE_PRODUCT_LIMIT = int(os.getenv("SHOPEE_PRODUCT_LIMIT", "5"))
POST_INTERVAL_SEGUNDOS = max(int(os.getenv("POST_INTERVAL_SEGUNDOS", "120")), 1)

SHOPEE_VENDAS_MINIMAS = int(os.getenv("SHOPEE_VENDAS_MINIMAS", "1000"))
SHOPEE_AVALIACAO_MINIMA = float(os.getenv("SHOPEE_AVALIACAO_MINIMA", "4.5"))

# Bloqueia roupas e peças exclusivamente femininas. Moda masculina continua liberada.
# Os termos podem ser alterados no .env sem mexer no código.
TERMOS_BLOQUEADOS_FEMININOS = [
    termo.strip()
    for termo in os.getenv(
        "TERMOS_BLOQUEADOS_FEMININOS",
        "roupa feminina,moda feminina,biquini,bikini,maio,maiô,top feminino,top cropped,cropped,sutia,sutiã,lingerie,calcinha,calcinhas,camisola,pijama feminino,vestido,vestidos,saia,saias,short feminino,shorts feminino,body feminino,body feminino,conjunto feminino,conjuntos femininos,macacao feminino,macacão feminino,blusa feminina,blusas femininas,camisa feminina,camiseta feminina,regata feminina,legging feminina,calca feminina,calça feminina,jeans feminino,moda intima feminina,moda íntima feminina,roupa intima feminina,roupa íntima feminina,conjunto intimo feminino,conjunto íntimo feminino,roupa sensual feminina"
    ).split(",")
    if termo.strip()
]

# Quantos produtos pedir por página.
# 50 é um bom equilíbrio entre velocidade e carga na API.
SHOPEE_BUSCA_BRUTA = int(os.getenv("SHOPEE_BUSCA_BRUTA", "50"))

# Intervalo entre requisições de páginas.
# Não deixe muito baixo para evitar rate limit da API.
SHOPEE_INTERVALO_PAGINAS = float(
    os.getenv("SHOPEE_INTERVALO_PAGINAS", "0.3")
)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Client | None = None

# Cache local em memória dos produtos que já foram enviados.
# O histórico permanente continua no Supabase.
postados_cache = set()


# ===================== CONFIGURAÇÃO =====================

def checar_configuracao():
    obrigatorias = {
        "SHOPEE_APP_ID": SHOPEE_APP_ID,
        "SHOPEE_SECRET": SHOPEE_SECRET,
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_KEY": SUPABASE_KEY,
    }

    faltando = [k for k, v in obrigatorias.items() if not v]

    if faltando:
        print("Faltam configurar estas variáveis:")
        for nome in faltando:
            print(f"  - {nome}")
        sys.exit(1)

    if not WHATSAPP_ENABLED:
        print("WHATSAPP_ENABLED está desligado. Ative para enviar promoções.")

    if WHATSAPP_ENABLED and not WHATSAPP_GROUP_ID:
        print("WHATSAPP_GROUP_ID não foi configurado.")
        sys.exit(1)

    global supabase
    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("Supabase conectado com sucesso.")


# ===================== SUPABASE =====================

def id_do_produto(produto: dict) -> str:
    """ID estável. Primeiro usa itemId da Shopee."""
    if produto.get("itemId") is not None:
        return str(produto["itemId"])

    return str(
        produto.get("offerLink")
        or produto.get("productName", "")
    ).strip()


def carregar_historico_supabase():
    """
    Carrega os IDs já enviados para a memória.
    Faz paginação para não depender de um limite pequeno de linhas.
    """
    global postados_cache

    if not supabase:
        raise RuntimeError("Supabase não foi inicializado.")

    inicio = 0
    tamanho = 1000
    total = 0

    while True:
        resposta = (
            supabase
            .table("produtos_postados")
            .select("produto_id")
            .range(inicio, inicio + tamanho - 1)
            .execute()
        )

        linhas = resposta.data or []

        for linha in linhas:
            produto_id = linha.get("produto_id")
            if produto_id:
                postados_cache.add(str(produto_id))

        total += len(linhas)

        if len(linhas) < tamanho:
            break

        inicio += tamanho

    print(f"Histórico carregado do Supabase: {total} produtos.")


def salvar_produto_postado(produto: dict) -> bool:
    """Salva no Supabase depois que o WhatsApp confirmou o envio."""
    if not supabase:
        print("⚠️ Supabase não inicializado; histórico não foi salvo.")
        return False

    produto_id = id_do_produto(produto)
    url = produto.get("offerLink") or ""
    nome = produto.get("productName", "Produto")

    try:
        # Usa as colunas criadas no Supabase: produto_id + url.
        # on_conflict evita erro caso o produto já exista.
        supabase.table("produtos_postados").upsert(
            {
                "produto_id": produto_id,
                "url": url,
            },
            on_conflict="produto_id",
        ).execute()

        postados_cache.add(produto_id)
        print(f"Salvo no Supabase: {produto_id}")
        return True

    except Exception as e:
        # O WhatsApp já confirmou o envio. Mantemos o ID no cache desta execução
        # para impedir que um erro de banco cause um flood imediato.
        postados_cache.add(produto_id)
        print(
            f"⚠️ Produto enviado, mas não foi salvo no Supabase: "
            f"{nome} | {e}"
        )
        return False


# ===================== SHOPEE =====================

def gerar_assinatura(payload: str):
    timestamp = int(time.time())
    base_string = f"{SHOPEE_APP_ID}{timestamp}{payload}{SHOPEE_SECRET}"
    assinatura = hashlib.sha256(
        base_string.encode("utf-8")
    ).hexdigest()

    return assinatura, timestamp


QUERY_PRODUTOS = """
query productOfferV2($keyword: String, $page: Int, $limit: Int, $sortType: Int) {
  productOfferV2(
    keyword: $keyword,
    page: $page,
    limit: $limit,
    sortType: $sortType
  ) {
    nodes {
      itemId
      productName
      priceMin
      priceMax
      priceDiscountRate
      sales
      ratingStar
      offerLink
      imageUrl
    }
    pageInfo {
      page
      limit
      hasNextPage
    }
  }
}
"""


def buscar_pagina(pagina: int):
    """Busca UMA página. Assim podemos filtrar/postar antes da próxima."""
    limite = min(max(SHOPEE_BUSCA_BRUTA, 1), 500)

    variables = {
        "keyword": SHOPEE_SEARCH_KEYWORD or None,
        "page": pagina,
        "limit": limite,
        "sortType": 1,  # relevância / busca geral
    }

    body = {
        "query": QUERY_PRODUTOS,
        "variables": variables,
    }

    payload = json.dumps(
        body,
        separators=(",", ":")
    )

    assinatura, timestamp = gerar_assinatura(payload)

    headers = {
        "Content-Type": "application/json",
        "Authorization": (
            f"SHA256 Credential={SHOPEE_APP_ID}, "
            f"Timestamp={timestamp}, "
            f"Signature={assinatura}"
        ),
    }

    resposta = requests.post(
        SHOPEE_API_URL,
        headers=headers,
        data=payload,
        timeout=30,
    )

    resposta.raise_for_status()
    dados = resposta.json()

    if dados.get("errors"):
        raise Exception(
            f"Erro retornado pela API da Shopee: {dados['errors']}"
        )

    resultado = dados["data"]["productOfferV2"]

    return (
        resultado.get("nodes") or [],
        resultado.get("pageInfo") or {},
    )


def normalizar_texto(texto) -> str:
    """Minúsculas + sem acentos, para o filtro pegar variações do título."""
    texto = str(texto or "").lower()
    texto = unicodedata.normalize("NFD", texto)
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    texto = re.sub(r"[^a-z0-9]+", " ", texto)
    return f" {texto.strip()} "


def produto_e_feminino_bloqueado(produto: dict) -> bool:
    """Retorna True para roupas/peças femininas que não devem ser postadas."""
    nome = normalizar_texto(produto.get("productName", ""))

    for termo in TERMOS_BLOQUEADOS_FEMININOS:
        termo_normalizado = normalizar_texto(termo).strip()
        if termo_normalizado and termo_normalizado in nome:
            return True

    return False


def produto_passou_filtro(produto: dict) -> bool:
    # Primeiro remove roupas e peças femininas, inclusive biquíni, sutiã,
    # calcinha, camisola, vestido, saia, cropped e outras variações configuradas.
    if produto_e_feminino_bloqueado(produto):
        return False

    try:
        vendas = float(produto.get("sales") or 0)
        avaliacao = float(produto.get("ratingStar") or 0)
    except (TypeError, ValueError):
        return False

    return (
        vendas >= SHOPEE_VENDAS_MINIMAS
        and avaliacao >= SHOPEE_AVALIACAO_MINIMA
    )


# ===================== FORMATAÇÃO =====================

def _para_float(valor, padrao=0.0):
    try:
        return float(valor)
    except (TypeError, ValueError):
        return padrao


def formatar_valor_brl(valor: float) -> str:
    return f"R$ {valor:.2f}".replace(".", ",")


def calcular_precos(produto: dict):
    preco_atual = _para_float(produto.get("priceMin") or produto.get("priceMax") or 0)
    taxa_desconto = _para_float(produto.get("priceDiscountRate"))
    preco_original = None
    percentual = 0

    if 0 < taxa_desconto < 100:
        preco_original = preco_atual / (1 - taxa_desconto / 100)
        percentual = round(taxa_desconto)

    return preco_atual, preco_original, percentual

# ===================== WHATSAPP (via serviço Node.js/Baileys) =====================

def formatar_bloco_preco_texto(produto: dict) -> str:
    preco_atual, preco_original, percentual = calcular_precos(produto)
    preco_atual_fmt = formatar_valor_brl(preco_atual)

    if preco_original and percentual > 0:
        preco_original_fmt = formatar_valor_brl(preco_original)
        return (
            f"~{preco_original_fmt}~ 🏷️ -{percentual}% OFF\n"
            f"💵 *{preco_atual_fmt}*"
        )

    return f"💵 *{preco_atual_fmt}*"


def formatar_mensagem_whatsapp(produto: dict) -> str:
    nome = produto.get("productName", "Produto")
    bloco_preco = formatar_bloco_preco_texto(produto)
    link = produto.get("offerLink", "")

    partes = [
        f"🔥 *{nome}*",
        bloco_preco,
        f"🔗 {link}",
    ]

    if WHATSAPP_CHANNEL_NAME:
        partes.append(WHATSAPP_CHANNEL_NAME)
    if WHATSAPP_CHANNEL_LINK:
        partes.append(WHATSAPP_CHANNEL_LINK)

    partes.append("#Anuncio #DivulgaPromos")
    return "\n\n".join(partes)


def enviar_whatsapp(mensagem: str, image_url: str = ""):
    url = f"{WHATSAPP_SERVICE_URL}/send"
    print(f"📡 Enviando para o serviço WhatsApp: {url}")

    resposta = requests.post(
        url,
        json={
            "group_id": WHATSAPP_GROUP_ID,
            "message": mensagem,
            "image_url": image_url or "",
        },
        timeout=60,
    )
    resposta.raise_for_status()
    return resposta.json()


# ===================== RENDER / UPTIMEROBOT =====================
#
# O health check e o QR code agora são servidos pelo server.js (Node),
# que já ocupa a porta $PORT do Render. Manter um segundo servidor HTTP
# aqui no Python causava "Address already in use" e crashava o serviço.


# ===================== PROCESSAMENTO OTIMIZADO =====================

def processar_produto(produto: dict) -> bool:
    """Envia UM produto para o WhatsApp e registra o histórico."""
    produto_id = id_do_produto(produto)

    if produto_id in postados_cache:
        return False

    if not produto_passou_filtro(produto):
        return False

    nome = produto.get("productName", "Produto")

    try:
        if not WHATSAPP_ENABLED:
            print("⚠️ WhatsApp está desativado; produto não enviado.")
            return False

        # Envia primeiro.
        enviar_whatsapp(
            formatar_mensagem_whatsapp(produto),
            produto.get("imageUrl") or "",
        )

        # Marca imediatamente como enviado nesta execução para evitar repetição
        # caso o Supabase esteja temporariamente indisponível.
        postados_cache.add(produto_id)

        # Tenta persistir no Supabase, mas não transforma uma falha de banco
        # em uma nova tentativa imediata no WhatsApp.
        salvar_produto_postado(produto)

        print(
            f"📲 Postado no WhatsApp: {nome} | "
            f"vendas={produto.get('sales')} | "
            f"avaliação={produto.get('ratingStar')}"
        )
        return True

    except Exception as e:
        print(f"❌ Erro ao enviar para o WhatsApp '{nome}': {e}")
        return False


def rodar_uma_vez():
    """
    Otimização principal:

    Antes:
      TODAS as páginas -> filtro -> Supabase -> posts.

    Agora:
      página -> filtro -> posta imediatamente -> próxima página.

    Para cada rodada, para ao atingir SHOPEE_PRODUCT_LIMIT.
    """
    print(
        "Buscando produtos da Shopee "
        "(geral/relevância, página por página)..."
    )

    limite_posts = max(SHOPEE_PRODUCT_LIMIT, 1)
    postados_nesta_rodada = 0
    pagina = 1

    while True:
        try:
            produtos, page_info = buscar_pagina(pagina)
        except Exception as e:
            print(f"Erro ao buscar página {pagina}: {e}")
            return

        print(
            f"Página {pagina}: {len(produtos)} produtos encontrados"
        )

        if not produtos:
            print("A Shopee não retornou mais produtos.")
            break

        validos = 0
        novos = 0

        for produto in produtos:
            if not produto_passou_filtro(produto):
                continue

            validos += 1
            produto_id = id_do_produto(produto)

            if produto_id in postados_cache:
                continue

            novos += 1

            # Envia um produto e aguarda o intervalo configurado
            # antes de permitir o próximo envio.
            if processar_produto(produto):
                postados_nesta_rodada += 1

                if postados_nesta_rodada >= limite_posts:
                    print(
                        f"Limite da rodada atingido: "
                        f"{postados_nesta_rodada} produto(s)."
                    )
                    return

                print(
                    f"⏳ Aguardando {POST_INTERVAL_SEGUNDOS}s "
                    f"antes da próxima promoção..."
                )
                time.sleep(POST_INTERVAL_SEGUNDOS)

        print(
            f"Página {pagina}: {validos} passaram no filtro, "
            f"{novos} eram novos."
        )

        if not page_info.get("hasNextPage"):
            print("Fim das páginas disponíveis nesta busca.")
            break

        pagina += 1

        # Pequena pausa para respeitar a API.
        time.sleep(SHOPEE_INTERVALO_PAGINAS)

    if postados_nesta_rodada == 0:
        print("Nenhum produto novo encontrado nesta rodada.")


def rodar_continuamente():
    while True:
        inicio = time.time()

        try:
            rodar_uma_vez()
        except Exception as e:
            print(f"Erro no ciclo de postagem: {e}")

        duracao = time.time() - inicio

        print(
            f"Rodada terminada em {duracao:.1f}s. "
            f"Aguardando {POST_INTERVAL_SEGUNDOS}s antes de nova busca..."
        )

        time.sleep(max(POST_INTERVAL_SEGUNDOS, 1))


# ===================== MAIN =====================

if __name__ == "__main__":
    checar_configuracao()
    carregar_historico_supabase()

    if "--loop" in sys.argv:
        rodar_continuamente()
    else:
        rodar_uma_vez()
