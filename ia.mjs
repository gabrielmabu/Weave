/**
 * ia.mjs — fontes → JSON de notas, via Gemini.
 *
 * Duas passadas:
 *   1. índice   — lê as fontes e devolve grupos + notas (sem conteúdo)
 *   2. conteúdo — escreve o markdown de cada nota, em lotes
 *
 * Por que duas: um material grande gera mais texto do que cabe numa única
 * resposta, e o modelo trunca no meio. Separar também melhora o resultado,
 * porque a estrutura é decidida antes de qualquer redação.
 *
 * As fontes são reenviadas em toda chamada — a API é sem estado. Isso custa
 * tokens de entrada repetidos, e é o motivo de a passada 2 ir em lotes: 30
 * notas em lotes de 5 são 6 chamadas, não 30. É também por isso que tudo o que
 * não é PDF chega aqui já convertido em texto pelo `fontes.mjs`: texto pesa
 * muito menos por reenvio.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { carregaEnv } from "./env.mjs";
import { leFonte, tokensDeTexto } from "./fontes.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Para onde vai o progresso.
 *
 * Na linha de comando é o console; no servidor, a tela de quem está esperando.
 * Usa AsyncLocalStorage em vez de uma variável de módulo porque dois jobs
 * concorrentes embaralhariam o relatório um do outro — cada execução carrega
 * o seu destino pelo contexto assíncrono.
 */
const contexto = new AsyncLocalStorage();

const log = (...args) => (contexto.getStore()?.relator ?? console.log)(...args);
const aviso = (...args) => (contexto.getStore()?.relator ?? console.warn)(...args);

/** Roda `fn` reportando progresso para `relator` em vez do console. */
export function comRelator(relator, fn) {
  return contexto.run({ relator }, fn);
}

// ---------------------------------------------------------------- schemas

// Schema no formato que o Gemini aceita (subconjunto do OpenAPI).
// propertyOrdering importa: sem ele a ordem dos campos varia entre chamadas.
const SCHEMA_INDICE = {
  type: "OBJECT",
  properties: {
    titulo: { type: "STRING" },
    subtitulo: { type: "STRING" },
    grupos: { type: "ARRAY", items: { type: "STRING" } },
    notas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          titulo: { type: "STRING" },
          grupo: { type: "STRING" },
          resumo: { type: "STRING" },
          relacionado: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["id", "titulo", "grupo", "resumo", "relacionado"],
        propertyOrdering: ["id", "titulo", "grupo", "resumo", "relacionado"],
      },
    },
  },
  required: ["titulo", "subtitulo", "grupos", "notas"],
  propertyOrdering: ["titulo", "subtitulo", "grupos", "notas"],
};

const SCHEMA_CONTEUDO = {
  type: "OBJECT",
  properties: {
    notas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, conteudo: { type: "STRING" } },
        required: ["id", "conteudo"],
        propertyOrdering: ["id", "conteudo"],
      },
    },
  },
  required: ["notas"],
};

// ---------------------------------------------------------------- chamada

/**
 * Uma fonte no formato que a API entende.
 *
 * PDF vai como arquivo; tudo o mais já chegou aqui convertido em texto pelo
 * `fontes.mjs` e vai como texto — mais barato e de tamanho conhecido. O nome
 * do arquivo acompanha o texto porque, com várias fontes na mesma chamada, o
 * modelo precisa saber onde uma acaba e a outra começa para poder dizer que
 * um conceito apareceu nas duas.
 */
export function parteDaFonte(fonte) {
  if (fonte.pdf) {
    return { inlineData: { mimeType: "application/pdf", data: fonte.pdf.toString("base64") } };
  }
  return { text: `### Fonte: ${fonte.nome} (${fonte.tipo})\n\n${fonte.texto}` };
}

/**
 * Uma chamada ao Gemini com as fontes + prompt, exigindo JSON conforme o schema.
 *
 * Erros da API sobem com o corpo da resposta junto: numa primeira integração
 * a mensagem do servidor ("campo X desconhecido") é o que diagnostica, e
 * engolir isso transformaria um erro de campo num "deu erro" inútil.
 */
async function chamada({ apiKey, modelo, partes, prompt, schema, tentativas = 3 }) {
  const corpo = {
    contents: [
      {
        role: "user",
        parts: [...partes, { text: prompt }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.3,
      // Precisa ser explícito e generoso. O gemini-2.5-flash "pensa" antes de
      // responder, e os tokens de raciocínio saem DESTE mesmo orçamento — com
      // o padrão, um lote de 5 notas estourava com a resposta pela metade.
      maxOutputTokens: 32768,
    },
  };

  let ultimoErro;
  for (let n = 1; n <= tentativas; n++) {
    let resp;
    try {
      resp = await fetch(`${BASE}/${modelo}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(corpo),
      });
    } catch (e) {
      ultimoErro = new Error(`falha de rede: ${e.message}`);
      await espera(n);
      continue;
    }

    const texto = await resp.text();

    if (!resp.ok) {
      // 429 (cota) e 5xx valem nova tentativa; 4xx de request não.
      const temporario = resp.status === 429 || resp.status >= 500;
      ultimoErro = new Error(`HTTP ${resp.status}: ${texto.slice(0, 600)}`);
      if (!temporario) throw ultimoErro;
      if (n < tentativas) {
        aviso(`  ! ${resp.status}, tentando de novo (${n}/${tentativas - 1})`);
        await espera(n);
        continue;
      }
      throw ultimoErro;
    }

    let json;
    try {
      json = JSON.parse(texto);
    } catch {
      throw new Error(`resposta não é JSON: ${texto.slice(0, 300)}`);
    }

    const cand = json.candidates?.[0];
    if (!cand) {
      const motivo = json.promptFeedback?.blockReason;
      throw new Error(
        motivo
          ? `conteúdo bloqueado pelo filtro do Gemini (${motivo})`
          : `resposta sem candidatos: ${texto.slice(0, 300)}`,
      );
    }
    if (cand.finishReason === "MAX_TOKENS") {
      // Sinalizado em vez de fatal: quem chamou divide o lote e tenta de novo.
      const e = new Error("resposta truncada por limite de tokens");
      e.truncado = true;
      throw e;
    }

    const saida = cand.content?.parts?.map((p) => p.text).join("") ?? "";
    try {
      return { dados: JSON.parse(saida), uso: json.usageMetadata };
    } catch {
      throw new Error(`JSON inválido do modelo: ${saida.slice(0, 300)}`);
    }
  }
  throw ultimoErro;
}

const espera = (n) => new Promise((r) => setTimeout(r, 1000 * 2 ** (n - 1)));

// ----------------------------------------------------------- limite de PDF

/**
 * Aplica os limites de tamanho antes de qualquer chamada à API.
 *
 * O custo é dominado pelo tamanho do PDF: ele é reenviado em toda chamada,
 * então cada página entra na conta uma vez por lote. Cortar aqui é o botão
 * mais direto de controle de gasto — e cortar ANTES de chamar significa que
 * um arquivo grande demais custa zero, em vez de custar e depois falhar.
 */
async function aplicaLimites(pdf, { maxPaginas, tetoPaginas, tetoMb }) {
  const mb = pdf.length / 1024 / 1024;

  // Acima de ~20 MB o envio inline é recusado pela API.
  if (mb > tetoMb) {
    throw new Error(
      `PDF tem ${mb.toFixed(1)} MB, acima do teto de ${tetoMb} MB.\n` +
        "  Use --paginas N para mandar só as primeiras N páginas,\n" +
        "  ou aumente TETO_MB no .env se souber o que está fazendo.",
    );
  }

  const { PDFDocument } = await import("pdf-lib");
  let doc;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  } catch (e) {
    // Sem conseguir abrir, não dá para contar nem cortar páginas. Segue com o
    // arquivo original: pode ser que a API dê conta mesmo assim.
    aviso(`· aviso: não consegui inspecionar o PDF (${e.message}), seguindo sem limitar`);
    return pdf;
  }

  const total = doc.getPageCount();
  const alvo = maxPaginas > 0 ? Math.min(maxPaginas, total) : total;

  if (alvo >= total) {
    if (total > tetoPaginas) {
      throw new Error(
        `PDF tem ${total} páginas, acima do teto de ${tetoPaginas}.\n` +
          `  Custo estimado: ~${estimaTokens(total)} tokens de entrada por chamada.\n` +
          `  Rode com --paginas ${tetoPaginas} para cortar, ou ajuste TETO_PAGINAS no .env.`,
      );
    }
    log(`· ${total} páginas, ${mb.toFixed(1)} MB`);
    return pdf;
  }

  const corte = await PDFDocument.create();
  const paginas = await corte.copyPages(doc, [...Array(alvo).keys()]);
  for (const p of paginas) corte.addPage(p);
  const cortado = Buffer.from(await corte.save());

  log(
    `· cortado: ${alvo} de ${total} páginas ` +
      `(${(cortado.length / 1024 / 1024).toFixed(1)} MB, era ${mb.toFixed(1)} MB)`,
  );
  return cortado;
}

/** Estimativa grosseira, calibrada na execução real: 41 páginas ≈ 11.340 tokens. */
const estimaTokens = (paginas) => Math.round((paginas * 277) / 100) * 100;

// ------------------------------------------------------------- checkpoint

/**
 * Guarda o progresso em disco a cada lote.
 *
 * Existe porque a primeira execução real perdeu 4 chamadas já pagas quando o
 * lote 4 falhou. Com cota compartilhada com um app em produção, refazer
 * trabalho concluído não é só lentidão — é cota tirada de outro sistema.
 *
 * A chave inclui o hash do PDF, o modelo E os prompts. Os prompts são
 * essenciais: sem eles, ajustar um prompt e rodar de novo reaproveitaria em
 * silêncio o resultado do prompt antigo — ou seja, seria impossível afinar
 * prompt, porque a mudança nunca teria efeito visível.
 */
function abreCheckpoint(assinatura, modelo, prompts, caminho) {
  const chave = createHash("sha1")
    .update(assinatura)
    .update(String(modelo))
    .update(prompts.join(" "))
    .digest("hex")
    .slice(0, 12);

  let estado = { chave, indice: null, conteudos: {} };
  if (caminho && existsSync(caminho)) {
    try {
      const salvo = JSON.parse(readFileSync(caminho, "utf8"));
      if (salvo.chave === chave) {
        estado = salvo;
        const n = Object.keys(estado.conteudos).length;
        log(`· retomando checkpoint: ${n} nota(s) já escritas, sem custo`);
      } else {
        log("· checkpoint é de outro PDF/modelo/prompt — começando do zero");
      }
    } catch {
      aviso("· checkpoint ilegível, ignorando");
    }
  }

  const grava = () => {
    if (!caminho) return;
    try {
      mkdirSync(dirname(caminho), { recursive: true });
      writeFileSync(caminho, JSON.stringify(estado), "utf8");
    } catch (e) {
      // Falhar ao gravar checkpoint não pode derrubar um trabalho que deu certo.
      aviso(`· aviso: não consegui gravar o checkpoint (${e.message})`);
    }
  };

  return { estado, grava };
}

// ---------------------------------------------------------------- passadas

/**
 * Estima o custo sem chamar a API. Serve para decidir antes de gastar,
 * que é o ponto: descobrir o preço depois de pagar não ajuda ninguém.
 */
/**
 * Lê os arquivos e aplica os limites, uma vez só.
 *
 * Uma vez só importa: a versão anterior abria o mesmo PDF com o pdf-lib três
 * vezes por rodada (uma no corte, duas na estimativa). Além do desperdício, a
 * conta do freio podia ser feita sobre um arquivo diferente do que seria
 * enviado, porque cada leitura repetia o corte por conta própria.
 */
export async function preparaFontes(caminhos, opcoes = {}) {
  const env = carregaEnv();
  const lista = Array.isArray(caminhos) ? caminhos : [caminhos];
  const fontes = [];

  for (const entrada of lista) {
    const { caminho, nome } = typeof entrada === "string" ? { caminho: entrada, nome: entrada } : entrada;
    const fonte = await leFonte(caminho, nome);

    if (fonte.pdf) {
      const cortado = await aplicaLimites(fonte.pdf, {
        maxPaginas: Number(opcoes.paginas ?? env.MAX_PAGINAS ?? 0) || 0,
        tetoPaginas: Number(opcoes.tetoPaginas ?? env.TETO_PAGINAS ?? 60),
        tetoMb: Number(opcoes.tetoMb ?? env.TETO_MB ?? 18),
      });
      fonte.pdf = cortado;
      fonte.paginas = await contaPaginas(cortado);
    } else {
      log(`· ${fonte.nome}: ${fonte.tipo} convertido aqui (${fonte.texto.length.toLocaleString("pt-BR")} caracteres)`);
      for (const a of fonte.avisos) aviso(`  ! ${a}`);
    }
    fontes.push(fonte);
  }
  return fontes;
}

async function contaPaginas(pdf) {
  try {
    const { PDFDocument } = await import("pdf-lib");
    return (await PDFDocument.load(pdf, { ignoreEncryption: true })).getPageCount();
  } catch {
    return 0;
  }
}

/**
 * Quanto uma chamada custa de entrada, somando todas as fontes.
 *
 * PDF vai por página (é o que a medição real calibrou); texto vai por
 * caractere, e aí o número é EXATO em vez de estimado — a fonte já está
 * convertida e o tamanho é conhecido antes de qualquer chamada.
 */
function custoPorChamada(fontes) {
  return fontes.reduce(
    (t, f) => t + (f.pdf ? estimaTokens(f.paginas ?? 0) : tokensDeTexto(f.texto)),
    0,
  );
}

/**
 * Estima o custo sem chamar a API. Serve para decidir antes de gastar,
 * que é o ponto: descobrir o preço depois de pagar não ajuda ninguém.
 */
export async function estimativa(caminhos, opcoes = {}) {
  const env = carregaEnv();
  const fontes = opcoes.fontes ?? (await preparaFontes(caminhos, opcoes));
  const lote = Number(opcoes.lote ?? env.NOTAS_POR_LOTE ?? 12);

  const paginas = fontes.reduce((t, f) => t + (f.paginas ?? 0), 0);
  const caracteres = fontes.reduce((t, f) => t + (f.texto?.length ?? 0), 0);

  // O prompt do índice pede de 12 a 30 notas, com teto duro em 30. A
  // estimativa usa o teto porque errar para cima é seguro (o freio barra a
  // rodada cara) e errar para baixo não é (liberaria gasto que estoura).
  // Mantenha em sincronia com prompts/01-indice.md.
  const tamanho = paginas + Math.ceil(caracteres / 2500); // páginas-equivalente
  const notasEstimadas = Math.min(30, Math.max(12, Math.round(tamanho / 1.5)));
  const chamadas = 1 + Math.ceil(notasEstimadas / lote);
  const tokensPorChamada = custoPorChamada(fontes);

  return {
    fontes,
    paginas,
    caracteres,
    mb: fontes.reduce((t, f) => t + (f.pdf?.length ?? 0), 0) / 1024 / 1024,
    lote,
    notasEstimadas,
    chamadas,
    tokensPorChamada,
    tokensTotais: chamadas * tokensPorChamada,
  };
}

export async function fontesParaNotas(caminhos, opcoes = {}) {
  const env = carregaEnv();
  const apiKey = opcoes.apiKey ?? env.GEMINI_API_KEY;
  const modelo = opcoes.modelo ?? env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const lote = Number(opcoes.lote ?? env.NOTAS_POR_LOTE ?? 12);

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY vazia.\n" +
        "  Abra o arquivo .env e cole a chave depois do sinal de igual.\n" +
        "  Pegue em: https://aistudio.google.com/apikey",
    );
  }

  const fontes = opcoes.fontes ?? (await preparaFontes(caminhos, opcoes));
  if (!fontes.length) throw new Error("nenhuma fonte para ler");

  // Freio de gasto por rodada. O saldo é pré-pago e compartilhado com o app
  // em produção, então o pior caso não é uma fatura inesperada — é o saldo
  // acabar e o outro app parar. Este teto barra ANTES da primeira chamada.
  const tetoTokens = Number(opcoes.tetoTokens ?? env.TETO_TOKENS_POR_RODADA ?? 60000);
  const prev = await estimativa(null, { ...opcoes, fontes });
  if (tetoTokens > 0) {
    if (prev.tokensTotais > tetoTokens) {
      throw new Error(
        `estimativa de ${prev.tokensTotais.toLocaleString("pt-BR")} tokens de entrada ` +
          `passa do teto de ${tetoTokens.toLocaleString("pt-BR")} por rodada.\n` +
          `  ${prev.paginas} páginas · ~${prev.chamadas} chamadas · lote ${prev.lote}\n` +
          "  Opções: --paginas N para cortar, --lote maior para menos chamadas,\n" +
          "  ou ajustar TETO_TOKENS_POR_RODADA no .env se a rodada valer o gasto.",
      );
    }
    log(
      `· estimativa: ~${prev.tokensTotais.toLocaleString("pt-BR")} tokens de entrada ` +
        `(teto ${tetoTokens.toLocaleString("pt-BR")})`,
    );
  }
  // Guardado para a segunda checagem do freio, depois da passada 1.
  const custoDeUmaChamada = prev.tokensPorChamada;
  const partes = fontes.map(parteDaFonte);

  const objetivo = (opcoes.objetivo ?? env.OBJETIVO ?? "").trim();

  // O objetivo entra ANTES das regras, não depois: ele é o critério que
  // decide o que vira nota. Um mesmo PDF pede recortes diferentes para
  // "estudar para prova" e para "apresentar a um cliente".
  const comObjetivo = (base) =>
    objetivo
      ? `## Para que serve este mapa\n\n${objetivo}\n\n` +
        "Esse objetivo manda em tudo o que vem abaixo. Ao escolher o que\n" +
        "vira nota, como agrupar e o que ligar, pergunte a cada decisão se\n" +
        "ela serve a esse objetivo. Conteúdo que não serve fica de fora,\n" +
        "por mais central que pareça no material.\n\n---\n\n" +
        base
      : base;

  const prompt1 = comObjetivo(readFileSync(join(AQUI, "prompts", "01-indice.md"), "utf8"));
  const prompt2 = comObjetivo(readFileSync(join(AQUI, "prompts", "02-notas.md"), "utf8"));

  if (objetivo) log(`· objetivo: ${objetivo}`);

  const uso = { entrada: 0, saida: 0, chamadas: 0 };
  const soma = (u) => {
    uso.chamadas++;
    uso.entrada += u?.promptTokenCount ?? 0;
    uso.saida += u?.candidatesTokenCount ?? 0;
  };

  log(`· lendo ${fontes.map((f) => f.nome).join(", ")} com ${modelo}`);
  // A chave do checkpoint sai do hash de cada fonte, não dos bytes de um PDF:
  // com várias fontes, trocar qualquer uma precisa invalidar o que foi feito.
  const ck = abreCheckpoint(fontes.map((f) => f.hash).join(" "), modelo, [prompt1, prompt2], opcoes.checkpoint);

  // ---- passada 1: índice
  let indice = ck.estado.indice;
  if (indice) {
    log(`· passada 1/2 — reaproveitada do checkpoint (${indice.notas.length} notas)`);
  } else {
    log("· passada 1/2 — montando o índice");
    const r1 = await chamada({
      apiKey, modelo, partes, prompt: prompt1, schema: SCHEMA_INDICE,
    });
    soma(r1.uso);
    indice = r1.dados;
    if (!indice.notas?.length) throw new Error("o modelo não devolveu nota nenhuma");
    log(`  ${indice.notas.length} notas em ${indice.grupos.length} grupos`);
  }

  // Limpa antes de escrever conteúdo: ids órfãos aqui viram aresta descartada
  // em silêncio no gráfico, e o problema só apareceria como "mapa ralo".
  const ids = new Set(indice.notas.map((n) => n.id));
  let podados = 0;
  for (const nota of indice.notas) {
    const antes = nota.relacionado?.length ?? 0;
    nota.relacionado = (nota.relacionado ?? []).filter((r) => r !== nota.id && ids.has(r));
    podados += antes - nota.relacionado.length;
  }
  if (podados) log(`  ${podados} ligação(ões) inválida(s) removida(s)`);

  ck.estado.indice = indice;
  ck.grava();

  // Segunda checagem do freio, agora com o número REAL de notas.
  //
  // A checagem inicial usa uma estimativa de quantas notas o material renderia,
  // e o modelo pode passar longe dela: numa rodada medida, a estimativa previu
  // 27 notas e vieram 51, fazendo o gasto real (104 mil) dobrar o previsto
  // (45 mil). Estimativa não é fiscalização — aqui o número é conhecido, então
  // dá para barrar de verdade, antes da parte cara.
  //
  // O índice já está no checkpoint: retomar depois de ajustar o teto não
  // repaga a passada 1.
  if (tetoTokens > 0) {
    const faltam = indice.notas.filter((n) => !ck.estado.conteudos[n.id]?.trim()).length;
    const chamadasReais = Math.ceil(faltam / lote);
    const gastoPrevisto = chamadasReais * custoDeUmaChamada;
    const jaGasto = uso.entrada;

    if (jaGasto + gastoPrevisto > tetoTokens) {
      throw new Error(
        `a passada 2 passaria do teto de ${tetoTokens.toLocaleString("pt-BR")} tokens.\n` +
          `  já gastos: ${jaGasto.toLocaleString("pt-BR")}\n` +
          `  o modelo devolveu ${indice.notas.length} notas (a estimativa previa menos),\n` +
          `  o que daria ~${chamadasReais} chamadas e mais ~${gastoPrevisto.toLocaleString("pt-BR")} tokens.\n` +
          "  O índice está salvo no checkpoint — nada do que já foi pago se perde.\n" +
          "  Rode de novo com --lote maior, ou aumente TETO_TOKENS_POR_RODADA.",
      );
    }
  }

  // ---- passada 2: conteúdo
  const conteudos = new Map(Object.entries(ck.estado.conteudos));
  const pendentes = indice.notas.filter((n) => !conteudos.get(n.id)?.trim());

  if (!pendentes.length) {
    log("· passada 2/2 — tudo já estava no checkpoint");
  } else {
    const lotes = [];
    for (let i = 0; i < pendentes.length; i += lote) lotes.push(pendentes.slice(i, i + lote));
    log(
      `· passada 2/2 — ${pendentes.length} nota(s) pendente(s) em ${lotes.length} lote(s) de até ${lote}`,
    );

    /** Escreve um lote; se a resposta truncar, divide ao meio e insiste. */
    const escreve = async (grupo, nivel = 0) => {
      const pedido =
        prompt2 +
        "\n\n## Notas deste lote\n\n" +
        grupo
          .map((n) => `- id: \`${n.id}\`\n  título: ${n.titulo}\n  recorte: ${n.resumo}`)
          .join("\n");
      try {
        const r2 = await chamada({
          apiKey, modelo, partes, prompt: pedido, schema: SCHEMA_CONTEUDO,
        });
        soma(r2.uso);
        for (const item of r2.dados.notas ?? []) {
          conteudos.set(item.id, item.conteudo);
          ck.estado.conteudos[item.id] = item.conteudo;
        }
        return r2.dados.notas?.length ?? 0;
      } catch (e) {
        // Truncou com mais de uma nota: o lote era grande demais, divide.
        if (e.truncado && grupo.length > 1) {
          const meio = Math.ceil(grupo.length / 2);
          aviso(`  ! resposta truncada, dividindo em ${meio} + ${grupo.length - meio}`);
          return (await escreve(grupo.slice(0, meio), nivel + 1)) +
                 (await escreve(grupo.slice(meio), nivel + 1));
        }
        // Truncou com uma nota só: nem dividindo cabe. Registra e segue, em
        // vez de derrubar a execução inteira por causa de uma nota.
        if (e.truncado) {
          aviso(`  ! nota '${grupo[0].id}' não coube na resposta, seguindo sem ela`);
          return 0;
        }
        throw e;
      }
    };

    for (const [i, grupo] of lotes.entries()) {
      const n = await escreve(grupo);
      ck.grava();
      log(`  lote ${i + 1}/${lotes.length} · ${n} nota(s)`);
    }
  }

  // Nota sem conteúdo entraria no HTML como seção vazia — melhor avisar.
  const vazias = indice.notas.filter((n) => !conteudos.get(n.id)?.trim());
  if (vazias.length) {
    aviso(`  ! ${vazias.length} nota(s) voltaram sem conteúdo: ${vazias.map((n) => n.id).join(", ")}`);
  }

  for (const nota of indice.notas) nota.conteudo = conteudos.get(nota.id) ?? "";

  log(
    `· ${uso.chamadas} chamadas · ${uso.entrada.toLocaleString("pt-BR")} tokens de entrada · ` +
      `${uso.saida.toLocaleString("pt-BR")} de saída`,
  );

  return indice;
}

// ------------------------------------------------------------------- tecer

const SCHEMA_TECER = {
  type: "OBJECT",
  properties: {
    reforcos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, porque: { type: "STRING" } },
        required: ["id", "porque"],
        propertyOrdering: ["id", "porque"],
      },
    },
    gruposNovos: { type: "ARRAY", items: { type: "STRING" } },
    notasNovas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          titulo: { type: "STRING" },
          grupo: { type: "STRING" },
          resumo: { type: "STRING" },
          relacionado: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["id", "titulo", "grupo", "resumo", "relacionado"],
        propertyOrdering: ["id", "titulo", "grupo", "resumo", "relacionado"],
      },
    },
  },
  required: ["reforcos", "gruposNovos", "notasNovas"],
  propertyOrdering: ["reforcos", "gruposNovos", "notasNovas"],
};

/**
 * Acrescenta uma fonte a um mapa que já existe.
 *
 *   A) fonte nova + índice atual  → notas novas, ligações, reforços
 *   B) conteúdo das notas novas, em lotes
 *   C) reescrita das notas reforçadas, em lotes
 *
 * O que faz isto ser barato: NENHUMA passada reenvia as fontes antigas.
 *
 * A passada C é a que costuma parecer cara e não é. Enriquecer uma nota não
 * precisa da apostila original — o texto que ela rendeu já está escrito e
 * guardado. Manda-se a fonte nova mais o texto atual das notas que casaram, e
 * pronto. Medido no mapa real de 51 notas: tecer sai por ~21 mil tokens de
 * entrada contra ~129 mil para refazer o mapa do zero com as duas fontes.
 *
 * Se o log desta função mostrar gasto na casa dos 130 mil, algo aqui voltou a
 * mandar o material antigo — é esse número, e não a impressão de que funcionou,
 * que diz se está tecendo ou refazendo.
 */
export async function tecerFonte(mapa, caminhos, opcoes = {}) {
  const env = carregaEnv();
  const apiKey = opcoes.apiKey ?? env.GEMINI_API_KEY;
  const modelo = opcoes.modelo ?? env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const lote = Number(opcoes.lote ?? env.NOTAS_POR_LOTE ?? 12);

  if (!apiKey) throw new Error("GEMINI_API_KEY vazia.");

  const fontes = opcoes.fontes ?? (await preparaFontes(caminhos, opcoes));
  if (fontes.length !== 1) throw new Error("tecer aceita uma fonte por vez");
  const nova = fontes[0];

  // Recusa por hash, antes de qualquer chamada: tecer o mesmo arquivo duas
  // vezes duplicaria notas e queimaria cota para piorar o mapa.
  const repetida = (mapa.fontes ?? []).find((f) => f.hash && f.hash === nova.hash);
  if (repetida) {
    const e = new Error(`este arquivo já foi tecido nesta teia como "${repetida.nome}"`);
    e.repetida = true;
    throw e;
  }

  const partes = [parteDaFonte(nova)];
  const objetivo = (opcoes.objetivo ?? "").trim();
  const foco = (opcoes.foco ?? "").trim();

  const comContexto = (base) => {
    let cabeca = "";
    if (objetivo) {
      cabeca +=
        `## Para que serve esta teia\n\n${objetivo}\n\n` +
        "Esse objetivo manda em tudo o que vem abaixo: ao decidir o que vira\n" +
        "nota e o que se liga, pergunte se serve a ele.\n\n";
    }
    if (foco) cabeca += `## Foco pedido para este material\n\n${foco}\n\n`;
    return cabeca ? `${cabeca}---\n\n${base}` : base;
  };

  const prompt3 = comContexto(readFileSync(join(AQUI, "prompts", "03-tecer.md"), "utf8"));
  const prompt2 = comContexto(readFileSync(join(AQUI, "prompts", "02-notas.md"), "utf8"));
  const prompt4 = comContexto(readFileSync(join(AQUI, "prompts", "04-enriquecer.md"), "utf8"));

  // A chave do checkpoint inclui o MAPA DE ORIGEM: tecer o mesmo arquivo em
  // duas teias diferentes precisa dar resultados diferentes, e sem isto a
  // segunda reaproveitaria o trabalho da primeira em silêncio.
  const assinaturaDoMapa = createHash("sha1")
    .update(mapa.notas.map((n) => `${n.id}:${n.titulo}`).join(" "))
    .digest("hex");
  const ck = abreCheckpoint(
    `${nova.hash} ${assinaturaDoMapa}`, modelo, [prompt3, prompt2, prompt4], opcoes.checkpoint,
  );

  const uso = { entrada: 0, saida: 0, chamadas: 0 };
  const soma = (u) => {
    uso.chamadas++;
    uso.entrada += u?.promptTokenCount ?? 0;
    uso.saida += u?.candidatesTokenCount ?? 0;
  };

  const teto = Number(opcoes.tetoTokens ?? env.TETO_TOKENS_POR_RODADA ?? 60000);
  const custoFonte = custoPorChamada(fontes);

  log(`· tecendo ${nova.nome} em "${mapa.titulo}" (${mapa.notas.length} notas, ${(mapa.fontes ?? []).length} fonte(s))`);

  // ---- passada A: o que a fonte acrescenta e onde ela encosta
  let plano = ck.estado.plano;
  if (plano) {
    log(`· passada 1/3 — reaproveitada do checkpoint`);
  } else {
    log("· passada 1/3 — lendo a fonte contra o mapa atual");
    const indice = mapa.notas
      .map((n) => `- id: \`${n.id}\`\n  título: ${n.titulo}\n  recorte: ${n.resumo ?? ""}`)
      .join("\n");
    const r = await chamada({
      apiKey, modelo, partes, schema: SCHEMA_TECER,
      // Só id, título e recorte. Mandar o texto completo das 51 notas
      // multiplicaria o custo desta passada por dez sem melhorar a decisão.
      prompt: `${prompt3}\n\n## Índice do mapa atual\n\n${indice}`,
    });
    soma(r.uso);
    plano = r.dados;
    ck.estado.plano = plano;
    ck.grava();
  }

  const novas = (plano.notasNovas ?? []).slice(0, 15);
  const reforcos = plano.reforcos ?? [];
  log(`  ${novas.length} nota(s) nova(s) · ${reforcos.length} reforço(s)`);

  // Freio com os números REAIS, antes da parte cara. O índice já está no
  // checkpoint, então parar aqui não joga fora o que foi pago.
  const idsExistentes = new Set(mapa.notas.map((n) => n.id));
  const aEnriquecer = reforcos.filter((r) => idsExistentes.has(r.id)).map((r) => r.id);
  if (teto > 0) {
    const previstas = Math.ceil(novas.length / lote) + Math.ceil(aEnriquecer.length / lote);
    const previsto = previstas * custoFonte + textoDasNotas(mapa, aEnriquecer).length / 4;
    if (uso.entrada + previsto > teto) {
      throw new Error(
        `tecer passaria do teto de ${teto.toLocaleString("pt-BR")} tokens.\n` +
          `  já gastos: ${uso.entrada.toLocaleString("pt-BR")}\n` +
          `  faltariam ~${Math.round(previsto).toLocaleString("pt-BR")} em ~${previstas} chamadas.\n` +
          "  O plano está salvo no checkpoint — nada do que já foi pago se perde.",
      );
    }
  }

  // ---- passada B: conteúdo das notas novas
  const conteudos = new Map(Object.entries(ck.estado.conteudos));
  const pendentes = novas.filter((n) => !conteudos.get(n.id)?.trim());
  if (!pendentes.length) {
    log("· passada 2/3 — nada a escrever");
  } else {
    const lotes = [];
    for (let i = 0; i < pendentes.length; i += lote) lotes.push(pendentes.slice(i, i + lote));
    log(`· passada 2/3 — escrevendo ${pendentes.length} nota(s) em ${lotes.length} lote(s)`);
    for (const [i, grupo] of lotes.entries()) {
      const pedido =
        prompt2 +
        "\n\n## Notas deste lote\n\n" +
        grupo.map((n) => `- id: \`${n.id}\`\n  título: ${n.titulo}\n  recorte: ${n.resumo}`).join("\n");
      const r = await chamada({ apiKey, modelo, partes, prompt: pedido, schema: SCHEMA_CONTEUDO });
      soma(r.uso);
      for (const item of r.dados.notas ?? []) {
        conteudos.set(item.id, item.conteudo);
        ck.estado.conteudos[item.id] = item.conteudo;
      }
      ck.grava();
      log(`  lote ${i + 1}/${lotes.length} · ${r.dados.notas?.length ?? 0} nota(s)`);
    }
  }
  for (const n of novas) n.conteudo = conteudos.get(n.id) ?? "";

  // ---- passada C: reescrita das notas que a fonte reforça
  const enriquecidos = new Map(Object.entries(ck.estado.enriquecidos ?? {}));
  const faltam = aEnriquecer.filter((id) => !enriquecidos.get(id)?.trim());
  if (!faltam.length) {
    log("· passada 3/3 — nada a enriquecer");
  } else {
    const lotes = [];
    for (let i = 0; i < faltam.length; i += lote) lotes.push(faltam.slice(i, i + lote));
    log(`· passada 3/3 — enriquecendo ${faltam.length} nota(s) em ${lotes.length} lote(s)`);
    ck.estado.enriquecidos ??= {};
    for (const [i, grupo] of lotes.entries()) {
      const r = await chamada({
        apiKey, modelo, partes, schema: SCHEMA_CONTEUDO,
        prompt: `${prompt4}\n\n## Notas a enriquecer\n\n${textoDasNotas(mapa, grupo)}`,
      });
      soma(r.uso);
      for (const item of r.dados.notas ?? []) {
        enriquecidos.set(item.id, item.conteudo);
        ck.estado.enriquecidos[item.id] = item.conteudo;
      }
      ck.grava();
      log(`  lote ${i + 1}/${lotes.length} · ${r.dados.notas?.length ?? 0} nota(s)`);
    }
  }

  log(
    `· ${uso.chamadas} chamadas · ${uso.entrada.toLocaleString("pt-BR")} tokens de entrada · ` +
      `${uso.saida.toLocaleString("pt-BR")} de saída`,
  );

  return {
    fonte: { id: null, nome: nova.nome, tipo: nova.tipo, hash: nova.hash, quando: new Date().toISOString() },
    notasNovas: novas,
    gruposNovos: plano.gruposNovos ?? [],
    reforcos,
    enriquecidos: Object.fromEntries(enriquecidos),
    uso,
  };
}

/** O texto atual das notas pedidas, para a passada de enriquecimento. */
function textoDasNotas(mapa, ids) {
  const porId = new Map(mapa.notas.map((n) => [n.id, n]));
  return ids
    .map((id) => porId.get(id))
    .filter(Boolean)
    .map((n) => `### id: \`${n.id}\` — ${n.titulo}\n\n${n.conteudo ?? ""}`)
    .join("\n\n---\n\n");
}
