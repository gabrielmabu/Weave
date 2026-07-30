# Cortex4U

Transforma um PDF de estudo num mapa mental navegável — grafo de bolinhas, barra lateral e notas.

Projeto **independente do Anotô**: repositório, dependências e deploy próprios. Dois vínculos, ambos temporários ou históricos:

- o `template.html` foi extraído do `Anotô.html`, que serviu de referência visual (histórico, já resolvido);
- a chave Gemini ainda vive no **mesmo projeto Google** do Anotô, então a cota gratuita é compartilhada. Ver [Chave de API](#chave-de-api).

## Estado

| Etapa | O quê | Situação |
|---|---|---|
| 1 | Template com marcadores | ✅ pronto |
| 2 | `render.mjs` — JSON → HTML | ✅ pronto e verificado no navegador |
| 3 | `ia.mjs` — PDF → JSON via Gemini | ✅ rodado em PDF real de 41 páginas |
| 4 | Ajuste de prompts | 🔄 em andamento — 2 de 3 alvos atingidos |

### O que o ajuste de prompt mudou (medido em PDF real de 41 páginas)

| Alvo | Antes | Depois | |
|---|---|---|---|
| Ligações cruzando grupo | 24% | 49% | ✅ |
| Notas sem nenhuma travessia | 19 | 3 | ✅ |
| Notas com diagrama | 1/39 | 7/51 | ✅ |
| Mediana de palavras por nota | 203 | 164 | ❌ piorou |
| Tokens de saída | 19.969 | 50.673 | ❌ 2,5× |

**A lição:** pedir "menos notas" e "notas mais longas" ao mesmo tempo produziu o
oposto — o modelo fez 51 notas em vez das 27 pedidas, e com mais notas para o
mesmo material cada uma ficou mais rasa. Instrução de **quantidade** por
proporção ("1 nota a cada 1,5 páginas") não se sustentou em material grande;
faixa explícita com teto duro ("12 a 30, nunca mais de 30") funcionou melhor.

O prompt atual voltou para a faixa explícita, mantendo os ganhos de ligação e
diagrama. **Ainda não revalidado em PDF grande** — custa ~1 rodada.

## Uso

```bash
npm install
cp .env.example .env          # e cole a chave dentro

node gerar.mjs --json exemplo.json -o saida/exemplo.html    # sem IA
node gerar.mjs apostila.pdf -o saida/apostila.html          # com IA
node gerar.mjs apostila.pdf -o saida/a.html --salvar-json saida/a.json
```

`--salvar-json` grava o JSON intermediário. Vale sempre usar na primeira
execução: se o HTML sair torto, dá para corrigir o JSON à mão e rerrenderizar
com `--json`, sem pagar a IA de novo.

### O que ainda não foi verificado na Etapa 3

O caminho de rede está testado (endpoint, cabeçalho e envio do PDF chegam ao
Google; a rejeição vem só na chave). O que **não** foi exercitado é o
`responseSchema` — o Google valida a chave antes do corpo, então a primeira
execução com chave válida é o teste real.

Se o schema for recusado, o erro vem com a mensagem do servidor junto, dizendo
qual campo ele não aceitou. É de propósito: numa primeira integração, engolir
essa mensagem transformaria um erro específico num "deu erro" inútil.

Abra o HTML gerado no navegador. Ele é autocontido (o mermaid vem embutido, ~3,3 MB), então funciona offline e dá para mandar por WhatsApp.

## Como funciona

O HTML final tem três partes geradas, e nada mais:

1. **seções** — uma `<section class="nota">` por nota, com o markdown convertido
2. **barra lateral** — links agrupados, com `data-slug` para o destaque na rolagem
3. **`window.__GRAPH_DATA__`** — o JSON de `nodes`/`links` que o grafo lê

Todo o comportamento (física do grafo, arrasto, zoom, pinça, clique-para-navegar, legenda, tamanho das bolinhas) já vem pronto no `template.html` e é derivado desse JSON sozinho. Não há código de front-end a escrever.

### Formato do JSON

```jsonc
{
  "titulo": "Direito Constitucional — Aula 3",
  "subtitulo": "opcional, aparece na topbar e como citação na home",
  "grupos": ["01 - Princípios", "02 - Direitos"],   // vira a legenda e o degradê de cores
  "notas": [
    {
      "id": "principio-da-legalidade",             // slug; vira a âncora #id
      "titulo": "Princípio da Legalidade",
      "grupo": "01 - Princípios",                  // precisa existir em 'grupos'
      "resumo": "uma linha, aparece no índice da home",
      "relacionado": ["reserva-legal"],            // vira as arestas do grafo
      "conteudo": "markdown; blocos ```mermaid viram diagrama"
    }
  ]
}
```

O nó `home` é criado automaticamente e ligado a todas as notas — é ele que dá ao grafo o miolo denso. O tamanho de cada bolinha sai do número de conexões, então `relacionado` é o que define o formato do mapa.

### Validação

`render.mjs` recusa o JSON antes de gerar qualquer coisa se houver id duplicado, grupo inexistente ou `relacionado` apontando para nota que não existe.

Isso não é preciosismo: o grafo do template **descarta em silêncio** links com id inválido. Sem a checagem, um erro do modelo apareceria como "o grafo saiu meio vazio" em vez de uma mensagem dizendo o que houve.

O `ia.mjs` faz uma limpeza antes disso — remove ligação para id inexistente e autoligação, e avisa quantas removeu. Assim erro comum do modelo vira aviso, não falha.

## Custo

**Gerar o HTML custa zero.** `render.mjs` é código local — a rerrenderização leva 0,2 s e nenhuma chamada de API. Todo o custo está nas duas passadas de IA.

A API não tem memória, então **o PDF é reenviado em toda chamada**. Medido num PDF de 41 páginas: ~11.400 tokens por chamada, e ~90% do total foi a mesma cópia do PDF repetida.

### Ver o custo antes de gastar

```bash
node gerar.mjs arquivo.pdf --estimar
node gerar.mjs arquivo.pdf --estimar --paginas 8
```

### Os dois botões de economia

| Botão | Efeito medido |
|---|---|
| `NOTAS_POR_LOTE` maior | Menos chamadas = menos cópias do PDF. Lote 5 → 102 mil tokens; lote 12 → 4 chamadas. |
| `--paginas N` | Corta o PDF antes de enviar. 41 páginas → 113 mil tokens; 8 páginas → 12 mil. |

Combinados, caiu de **113.399 para 12.365 tokens** de entrada (−89%).

> ⚠️ **`--paginas` distorce o resultado, não serve para uso real.** Com menos material o modelo fragmenta demais: 8 páginas geraram 35 notas com mediana de 64 palavras, contra 39 notas de 203 palavras no PDF inteiro. Use para testar o encanamento barato, não para gerar mapa de verdade.

### Limites que falham antes de gastar

Todos checados **antes** de qualquer chamada — descobrir que não vale a pena custa zero.

| Variável | Padrão | O que faz |
|---|---|---|
| `TETO_TOKENS_POR_RODADA` | 60.000 | **Freio principal.** Estima e barra a rodada inteira se passar. |
| `TETO_PAGINAS` | 60 | Recusa PDF com páginas demais. |
| `TETO_MB` | 18 | Recusa arquivo grande demais para envio inline. |

O freio de tokens é o que importa, porque considera páginas **e** número de chamadas juntos. A rodada real de 41 páginas com lote 5 (113.399 tokens) seria barrada; a mesma com lote 12 (~57.000) passa.

### Por que isso importa aqui

O saldo é **pré-pago** e **compartilhado com o Anotô** (projeto `zapcaixa`). Recarga automática desativada, então não existe fatura surpresa — mas existe o cenário de o saldo acabar e **o app de produção parar de responder**. O freio protege disso, não de cobrança.

## Onde monitorar o consumo

| O quê | Onde |
|---|---|
| Chamadas, erros, latência | Cloud Console → APIs e Serviços → Generative Language API → **Métricas** |
| Cota usada vs. limite | mesma API → **Cotas** (dá para baixar o teto, virando limite rígido) |
| Se há cobrança ativa | Cloud Console → **Faturamento** |

**Sem conta de faturamento vinculada, não há como ser cobrado** — a camada gratuita falha fechada: ao estourar a cota as chamadas passam a retornar 429 e param. Se houver faturamento vinculado, o excedente é cobrado automaticamente — nesse caso configure um teto em *Cotas* (limite rígido) e não só um alerta de orçamento (que avisa depois do gasto).

Para desligar de vez: **Desativar API** na página da Generative Language API, ou excluir a chave no AI Studio.

## Chave de API

Copie `.env.example` para `.env` e cole a chave (gere em [AI Studio](https://aistudio.google.com/apikey)). O `.env` está no `.gitignore` — nunca comitar.

**A cota gratuita do Gemini é contada por projeto, não por chave.** A chave atual foi criada dentro do projeto que o Anotô já usa (`projects/157433417948`), porque a criação de um projeto novo estava barrada com *"The request is suspicious"*. Consequência prática: processar um PDF grande consome cota do app de caixa em produção.

Uma chave separada dentro do mesmo projeto ainda vale a pena — isola a **revogação**, não o **limite**. Se uma vazar, você mata só ela.

**Pendência:** quando a criação de projeto destravar, gerar a chave num projeto próprio e trocar no `.env`. É a única forma de isolar a cota de verdade. Nenhuma linha de código muda.

### Se uma chave vazar

Revogue imediatamente em AI Studio → detalhes da chave → *Excluir chave*, e gere outra. Chave exposta em print, log ou commit deve ser considerada comprometida mesmo que pareça que ninguém viu.

## Ferramentas

`ferramentas/extrai-template.mjs` regenera o `template.html` a partir do `Anotô.html` original. Rodar só se o original mudar — o template já está commitado. O script valida cada âncora antes de mexer e falha alto se o arquivo de origem não for o esperado.
