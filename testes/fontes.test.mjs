/**
 * Testes da conversão local de fontes.
 *
 * A propriedade que interessa: o que sai daqui é texto que o modelo consegue
 * ler, e nenhum arquivo sai da máquina sem passar por esta etapa. Os casos
 * feios são de propósito — planilha de verdade tem célula com barra vertical,
 * quebra de linha e fórmula, e é exatamente aí que uma conversão ingênua
 * arruinaria a tabela sem dar erro nenhum.
 *
 *   npm run teste
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leFonte, leCsv, aceita, tokensDeTexto } from "../fontes.mjs";

function pasta() {
  const p = mkdtempSync(join(tmpdir(), "weave-fontes-"));
  return { p, limpa: () => rmSync(p, { recursive: true, force: true }) };
}

const arquivo = (p, nome, conteudo) => {
  const caminho = join(p, nome);
  writeFileSync(caminho, conteudo);
  return caminho;
};

// ------------------------------------------------------------------ formatos

test("aceita o que sabe ler e recusa o resto", () => {
  for (const n of ["a.pdf", "a.PDF", "a.txt", "a.md", "a.csv", "a.xlsx", "a.docx"]) {
    assert.ok(aceita(n), n);
  }
  for (const n of ["a.mp3", "a.png", "a.zip", "sem-extensao"]) {
    assert.ok(!aceita(n), n);
  }
});

test("recusar diz o que aceita, em vez de só falhar", async () => {
  const { p, limpa } = pasta();
  try {
    const c = arquivo(p, "aula.mp3", "x");
    await assert.rejects(() => leFonte(c, "aula.mp3"), /Aceito: \.pdf, \.txt/);
  } finally { limpa(); }
});

// ----------------------------------------------------------------------- pdf

test("PDF viaja como bytes, não como texto", async () => {
  const { p, limpa } = pasta();
  try {
    const c = arquivo(p, "a.pdf", "%PDF-1.4\n...");
    const f = await leFonte(c, "a.pdf");
    assert.equal(f.tipo, "pdf");
    assert.ok(Buffer.isBuffer(f.pdf));
    assert.equal(f.texto, undefined);
    assert.match(f.hash, /^[0-9a-f]{40}$/);
  } finally { limpa(); }
});

test("extensão .pdf em arquivo que não é PDF é recusada na hora", async () => {
  // Recusar aqui, e não depois da chamada: mandar isso para a API custaria
  // tokens para receber um erro que dava para prever de graça.
  const { p, limpa } = pasta();
  try {
    const c = arquivo(p, "falso.pdf", "isto e texto puro");
    await assert.rejects(() => leFonte(c, "falso.pdf"), /não é um PDF/);
  } finally { limpa(); }
});

// ----------------------------------------------------------------------- csv

test("CSV com vírgula, aspas e quebra de linha dentro do campo", () => {
  const linhas = leCsv('a,"b, com virgula",c\n"linha\ncom quebra","aspas ""duplas""",fim\n');
  assert.deepEqual(linhas, [
    ["a", "b, com virgula", "c"],
    ["linha\ncom quebra", 'aspas "duplas"', "fim"],
  ]);
});

test("CSV vira tabela markdown com as células perigosas neutralizadas", async () => {
  const { p, limpa } = pasta();
  try {
    const c = arquivo(p, "q.csv", 'questao,resposta\n"a | b","tem\nquebra"\n');
    const f = await leFonte(c, "q.csv");

    assert.equal(f.tipo, "csv");
    assert.equal(f.pdf, undefined);

    const linhas = f.texto.split("\n");
    assert.equal(linhas[0], "| questao | resposta |");
    assert.equal(linhas[1], "| --- | --- |");
    // A barra vertical escapada e a quebra achatada: a tabela continua com
    // duas colunas e duas linhas, que é o que importa.
    assert.equal(linhas[2], "| a \\| b | tem quebra |");
    assert.equal(linhas.length, 3);
  } finally { limpa(); }
});

// ---------------------------------------------------------------- texto puro

test("txt e md entram como texto, sem conversão", async () => {
  const { p, limpa } = pasta();
  try {
    const f = await leFonte(arquivo(p, "n.md", "# Título\n\ncorpo"), "n.md");
    assert.equal(f.tipo, "md");
    assert.equal(f.texto, "# Título\n\ncorpo");
  } finally { limpa(); }
});

test("arquivo vazio é recusado em vez de virar fonte muda", async () => {
  const { p, limpa } = pasta();
  try {
    await assert.rejects(() => leFonte(arquivo(p, "v.txt", "   \n "), "v.txt"), /vazio/);
  } finally { limpa(); }
});

// -------------------------------------------------------------------- xlsx

test("planilha de verdade vira tabela markdown, aba por aba", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const { p, limpa } = pasta();
  try {
    const wb = new ExcelJS.Workbook();

    const a = wb.addWorksheet("Questões");
    a.addRow(["nº", "enunciado", "gabarito"]);
    a.addRow([1, "Cabe recurso | agravo?", "C"]);
    a.addRow([2, "Texto com\nquebra de linha", "E"]);

    const b = wb.addWorksheet("Notas");
    b.addRow(["aluno", "nota"]);
    b.addRow(["Ana", 9.5]);

    // Aba vazia não pode virar seção prometendo conteúdo.
    wb.addWorksheet("Rascunho");

    const caminho = join(p, "prova.xlsx");
    await wb.xlsx.writeFile(caminho);

    const f = await leFonte(caminho, "prova.xlsx");
    assert.equal(f.tipo, "xlsx");
    assert.equal(f.pdf, undefined);

    assert.match(f.texto, /^## Questões/m);
    assert.match(f.texto, /^## Notas/m);
    assert.ok(!/## Rascunho/.test(f.texto), "aba vazia não deveria virar seção");

    assert.match(f.texto, /\| 1 \| Cabe recurso \\\| agravo\? \| C \|/);
    assert.match(f.texto, /\| 2 \| Texto com quebra de linha \| E \|/);
    assert.match(f.texto, /\| Ana \| 9\.5 \|/);

    // Cada aba com sua tabela: sem isso as duas grudariam numa só. Conta as
    // linhas separadoras inteiras — procurar o pedaço `| --- |` acharia duas
    // ocorrências numa linha de três colunas e mentiria o total.
    const separadoras = f.texto.split("\n").filter((l) => /^\|(?: -+ \|)+$/.test(l));
    assert.deepEqual(separadoras, ["| --- | --- | --- |", "| --- | --- |"]);
  } finally { limpa(); }
});

test("planilha sem nenhuma célula preenchida é recusada", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const { p, limpa } = pasta();
  try {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Vazia");
    const caminho = join(p, "vazia.xlsx");
    await wb.xlsx.writeFile(caminho);
    await assert.rejects(() => leFonte(caminho, "vazia.xlsx"), /nenhuma célula preenchida/);
  } finally { limpa(); }
});

// -------------------------------------------------------------------- custo

test("a estimativa de tokens do texto é conhecida antes de qualquer chamada", () => {
  // É isso que torna o freio exato para fontes de texto, em vez de aproximado
  // como no PDF, onde a conta é por página.
  assert.equal(tokensDeTexto("a".repeat(400)), 100);
  assert.equal(tokensDeTexto(""), 0);
});
