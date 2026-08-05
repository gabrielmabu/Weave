/**
 * fontes.mjs — todo arquivo vira algo que a API entende, aqui.
 *
 * Duas regras, e a segunda é a que economiza dinheiro:
 *
 *   1. PDF vai como PDF (a API lê nativamente, e converter perderia layout);
 *   2. TODO O RESTO vira texto ANTES de sair da máquina.
 *
 * Converter aqui custa zero — é código local, como o render.mjs. E o resultado
 * é muito mais barato de enviar: uma planilha vira uma tabela markdown
 * compacta, enquanto o mesmo conteúdo como PDF ou imagem custaria várias vezes
 * mais tokens. Some-se a isso que texto tem tamanho conhecido antes da
 * primeira chamada, então o freio de gasto passa a ser exato para essas fontes
 * em vez de aproximado.
 *
 * `.xlsx` e `.docx` são zip com XML dentro; a API não os aceita nativamente de
 * qualquer forma. As duas bibliotecas usadas rodam sem nenhuma chamada de rede
 * — o arquivo não sai daqui antes de virar texto.
 *
 * Sobre o `npm audit`: o exceljs arrasta um uuid com alerta moderado (falta de
 * checagem de limites em v3/v5/v6 QUANDO se passa um buffer). O exceljs chama
 * `uuidv4()` sem argumentos, e só no caminho de ESCRITA de planilha, que este
 * módulo nunca usa. O alerta não alcança o nosso código; fica registrado aqui
 * para a próxima pessoa não precisar refazer a investigação.
 *
 * Áudio e vídeo ainda não entram, mas o formato de retorno já reserva o lugar:
 * uma passada de transcrição devolveria `{ tipo: "audio", texto }` e daí para
 * baixo nada mudaria — a aula viraria texto e custaria como texto.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { sha1, tipoPeloNome } from "./mapa.mjs";

/** O que cada tipo vira. `pdf` é o único que viaja como arquivo. */
const COMO_TEXTO = new Set(["txt", "md", "csv", "xlsx", "docx"]);

export const EXTENSOES_ACEITAS = [".pdf", ".txt", ".md", ".csv", ".xlsx", ".docx"];

export const aceita = (nome) => EXTENSOES_ACEITAS.includes(extname(String(nome)).toLowerCase());

// ------------------------------------------------------------------ markdown

/**
 * Célula segura dentro de tabela markdown.
 *
 * Uma célula com `|` partiria a linha em duas colunas, e uma com quebra de
 * linha partiria a tabela inteira — e planilha de verdade tem as duas coisas.
 * Escapar a barra e achatar a quebra preserva o conteúdo em vez de descartar
 * a linha.
 */
function celula(valor) {
  if (valor == null) return "";
  let s = String(valor);
  if (typeof valor === "object") {
    // exceljs devolve objeto em fórmula (`{formula, result}`), hyperlink e
    // rich text. O que interessa é sempre o valor visível.
    s = String(valor.result ?? valor.text ?? valor.hyperlink ?? valor.richText?.map((r) => r.text).join("") ?? "");
  }
  if (valor instanceof Date) s = valor.toISOString().slice(0, 10);
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function tabelaMarkdown(linhas) {
  const usadas = linhas.filter((l) => l.some((c) => celula(c) !== ""));
  if (!usadas.length) return "";

  const colunas = Math.max(...usadas.map((l) => l.length));
  const linha = (l) =>
    `| ${Array.from({ length: colunas }, (_, i) => celula(l[i])).join(" | ")} |`;

  return [
    linha(usadas[0]),
    `| ${Array(colunas).fill("---").join(" | ")} |`,
    ...usadas.slice(1).map(linha),
  ].join("\n");
}

// ----------------------------------------------------------------------- csv

/**
 * CSV conforme a RFC 4180: campo entre aspas pode conter vírgula, quebra de
 * linha e aspas duplicadas.
 *
 * Escrito à mão porque `split(",")` erra justamente nos arquivos que importam
 * — qualquer célula com vírgula dentro (endereço, enunciado de questão) sairia
 * quebrada, e o erro apareceria como conteúdo embaralhado no mapa, longe da
 * causa.
 */
export function leCsv(texto) {
  const linhas = [];
  let linha = [], campo = "", aspas = false;

  // BOM no começo viraria parte do primeiro cabeçalho.
  const t = texto.replace(/^﻿/, "");

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++; }
        else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { aspas = true; continue; }
    if (c === ",") { linha.push(campo); campo = ""; continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      linha.push(campo); linhas.push(linha);
      linha = []; campo = "";
      continue;
    }
    campo += c;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

// --------------------------------------------------------------- conversores

async function deXlsx(bytes) {
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);

  const partes = [];
  wb.eachSheet((aba) => {
    const linhas = [];
    aba.eachRow({ includeEmpty: false }, (row) => {
      // `row.values` vem com um buraco no índice 0 (o exceljs conta colunas a
      // partir de 1); sem o slice, toda linha ganharia uma coluna vazia.
      linhas.push(Array.isArray(row.values) ? row.values.slice(1) : []);
    });
    const tabela = tabelaMarkdown(linhas);
    // Aba sem nada não vira seção: seria um título prometendo conteúdo que
    // não existe, e o modelo tentaria explicar o vazio.
    if (tabela) partes.push(`## ${aba.name}\n\n${tabela}`);
  });

  if (!partes.length) throw new Error("a planilha não tem nenhuma célula preenchida");
  return partes.join("\n\n");
}

async function deDocx(bytes) {
  const { default: mammoth } = await import("mammoth");
  const { value, messages } = await mammoth.convertToMarkdown({ buffer: bytes });
  const texto = value.trim();
  if (!texto) throw new Error("o documento não tem texto extraível");

  // Aviso de imagem ignorada é esperado e não é problema; qualquer outro vale
  // aparecer no log, porque significa conteúdo que não chegou ao mapa.
  const relevantes = messages.filter((m) => !/image/i.test(m.message));
  return { texto, avisos: relevantes.map((m) => m.message) };
}

// ------------------------------------------------------------------- entrada

/**
 * Lê um arquivo e devolve o que a API vai consumir.
 *
 *   { tipo, nome, hash, bytes, texto?, pdf?, avisos[] }
 *
 * `texto` e `pdf` são mutuamente exclusivos: quem chama testa qual veio em vez
 * de precisar saber a tabela de formatos. É essa a razão de este módulo
 * existir — o `ia.mjs` e o `servidor.mjs` não conhecem extensão nenhuma.
 */
export async function leFonte(caminho, nome = caminho) {
  const tipo = tipoPeloNome(nome);
  if (!aceita(nome)) {
    throw new Error(
      `não sei ler '${extname(nome) || nome}'. Aceito: ${EXTENSOES_ACEITAS.join(", ")}`,
    );
  }

  const bytes = await readFile(caminho);
  const base = { tipo, nome, hash: sha1(bytes), bytes: bytes.length, avisos: [] };

  if (tipo === "pdf") {
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("o arquivo tem extensão .pdf mas não é um PDF");
    }
    return { ...base, pdf: bytes };
  }

  if (!COMO_TEXTO.has(tipo)) throw new Error(`tipo inesperado: ${tipo}`);

  let texto, avisos = [];
  if (tipo === "xlsx") {
    texto = await deXlsx(bytes);
  } else if (tipo === "docx") {
    ({ texto, avisos } = await deDocx(bytes));
  } else if (tipo === "csv") {
    texto = tabelaMarkdown(leCsv(bytes.toString("utf8")));
    if (!texto) throw new Error("o CSV está vazio");
  } else {
    texto = bytes.toString("utf8").trim();
    if (!texto) throw new Error("o arquivo está vazio");
  }

  return { ...base, texto, avisos };
}

/**
 * Quantos tokens este texto deve custar de entrada.
 *
 * Regra grosseira e conservadora (~4 caracteres por token) — o suficiente para
 * o freio decidir antes de gastar. Para PDF a conta continua sendo por página,
 * no ia.mjs, porque lá o custo não sai do texto extraído.
 */
export const tokensDeTexto = (texto) => Math.ceil(texto.length / 4);
