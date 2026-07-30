/**
 * ia.mjs — PDF → JSON de notas, via Gemini.
 *
 * Duas passadas:
 *   1. índice   — lê o PDF e devolve grupos + notas (sem conteúdo)
 *   2. conteúdo — escreve o markdown de cada nota, em lotes
 *
 * Por que duas: um material grande gera mais texto do que cabe numa única
 * resposta, e o modelo trunca no meio. Separar também melhora o resultado,
 * porque a estrutura é decidida antes de qualquer redação.
 *
 * O PDF é reenviado em toda chamada — a API é sem estado. Isso custa tokens
 * de entrada repetidos, e é o motivo de a passada 2 ir em lotes: 30 notas em
 * lotes de 5 são 6 chamadas, não 30.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

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

/** Lê o .env sem dependência externa. Formato: CHAVE=valor, # comenta. */
function carregaEnv() {
  const env = { ...process.env };
  try {
    for (const linha of readFileSync(join(AQUI, ".env"), "utf8").split("\n")) {
      const corte = linha.indexOf("=");
      if (corte < 0) continue;
      const chave = linha.slice(0, corte).trim();
      if (!chave || chave.startsWith("#")) continue;
      // O .env só preenche o que ainda não veio do ambiente.
      if (env[chave] === undefined || env[chave] === "") {
        env[chave] = linha.slice(corte + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* sem .env: segue só com o ambiente */
  }
  return env;
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
 * Uma chamada ao Gemini com PDF + prompt, exigindo JSON conforme o schema.
 *
 * Erros da API sobem com o corpo da resposta junto: numa primeira integração
 * a mensagem do servidor ("campo X desconhecido") é o que diagnostica, e
 * engolir isso transformaria um erro de campo num "deu erro" inútil.
 */
async function chamada({ apiKey, modelo, pdfBase64, prompt, schema, tentativas = 3 }) {
  const corpo = {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
          { text: prompt },
        ],
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
function abreCheckpoint(pdf, modelo, prompts, caminho) {
  const chave = createHash("sha1")
    .update(pdf)
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
export async function estimativa(caminhoPdf, opcoes = {}) {
  const env = carregaEnv();
  const pdf = readFileSync(caminhoPdf);
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });

  const total = doc.getPageCount();
  const max = Number(opcoes.paginas ?? env.MAX_PAGINAS ?? 0) || 0;
  const paginas = max > 0 ? Math.min(max, total) : total;
  const lote = Number(opcoes.lote ?? env.NOTAS_POR_LOTE ?? 12);

  // O prompt do índice pede de 12 a 30 notas, com teto duro em 30. A
  // estimativa usa o teto porque errar para cima é seguro (o freio barra a
  // rodada cara) e errar para baixo não é (liberaria gasto que estoura).
  // Mantenha em sincronia com prompts/01-indice.md.
  const notasEstimadas = Math.min(30, Math.max(12, Math.round(paginas / 1.5)));
  const chamadas = 1 + Math.ceil(notasEstimadas / lote);
  const tokensPorChamada = estimaTokens(paginas);

  return {
    paginas,
    totalPaginas: total,
    mb: (pdf.length / 1024 / 1024) * (paginas / total),
    lote,
    notasEstimadas,
    chamadas,
    tokensPorChamada,
    tokensTotais: chamadas * tokensPorChamada,
  };
}

export async function pdfParaNotas(caminhoPdf, opcoes = {}) {
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

  let pdf;
  try {
    pdf = readFileSync(caminhoPdf);
  } catch (e) {
    throw new Error(`não consegui ler o PDF: ${e.message}`);
  }

  pdf = await aplicaLimites(pdf, {
    maxPaginas: Number(opcoes.paginas ?? env.MAX_PAGINAS ?? 0) || 0,
    tetoPaginas: Number(opcoes.tetoPaginas ?? env.TETO_PAGINAS ?? 60),
    tetoMb: Number(opcoes.tetoMb ?? env.TETO_MB ?? 18),
  });

  // Freio de gasto por rodada. O saldo é pré-pago e compartilhado com o app
  // em produção, então o pior caso não é uma fatura inesperada — é o saldo
  // acabar e o outro app parar. Este teto barra ANTES da primeira chamada.
  const tetoTokens = Number(opcoes.tetoTokens ?? env.TETO_TOKENS_POR_RODADA ?? 60000);
  if (tetoTokens > 0) {
    const prev = await estimativa(caminhoPdf, { paginas: opcoes.paginas, lote: opcoes.lote });
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

  const mb = pdf.length / 1024 / 1024;
  const pdfBase64 = pdf.toString("base64");
  // Guardado para a segunda checagem do freio, depois da passada 1.
  const paginasEnviadas = (await estimativa(caminhoPdf, { paginas: opcoes.paginas })).paginas;

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

  log(`· lendo ${caminhoPdf} (${mb.toFixed(1)} MB) com ${modelo}`);
  const ck = abreCheckpoint(pdf, modelo, [prompt1, prompt2], opcoes.checkpoint);

  // ---- passada 1: índice
  let indice = ck.estado.indice;
  if (indice) {
    log(`· passada 1/2 — reaproveitada do checkpoint (${indice.notas.length} notas)`);
  } else {
    log("· passada 1/2 — montando o índice");
    const r1 = await chamada({
      apiKey, modelo, pdfBase64, prompt: prompt1, schema: SCHEMA_INDICE,
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
    const gastoPrevisto = chamadasReais * estimaTokens(paginasEnviadas);
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
          apiKey, modelo, pdfBase64, prompt: pedido, schema: SCHEMA_CONTEUDO,
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
