/**
 * Regressão do defeito de 30/07/2026: notas voltando do modelo sem nenhuma
 * quebra de linha, o que fazia `##` e `1.` aparecerem como texto e tabelas
 * saírem escapadas (`&lt;table&gt;`) na tela.
 *
 * A fixture usa conteúdo REAL capturado do arquivo gerado, não um exemplo
 * inventado — um teste com entrada fabricada passaria sem provar nada sobre
 * o que o modelo de fato devolve.
 *
 *   node --test testes/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render } from "../render.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const dados = JSON.parse(readFileSync(join(AQUI, "defeito-markdown.json"), "utf8"));

const html = render(dados);
const secao = (id) => {
  const ini = html.indexOf(`<section id="${id}"`);
  return html.slice(ini, html.indexOf("</section>", ini));
};

const quebrada = secao("sem-quebras");
const controle = secao("controle-intacto");

test("não sobra marcação de tabela escapada na tela", () => {
  assert.ok(!quebrada.includes("&lt;table&gt;"), "ainda há <table> escapado");
  assert.ok(!quebrada.includes("&lt;td&gt;"), "ainda há <td> escapado");
});

test("a tabela em HTML virou tabela de verdade", () => {
  assert.ok(quebrada.includes("<table>"), "nenhuma <table> renderizada");
  assert.ok(quebrada.includes("<th>"), "tabela sem cabeçalho");
});

test("os títulos viraram h2 em vez de ## literal", () => {
  assert.ok(quebrada.includes("<h2>"), "nenhum h2 na nota quebrada");
  // O `##` só pode aparecer dentro de bloco de código, nunca solto no texto.
  assert.ok(!/[^>\n]##\s/.test(quebrada), "sobrou ## como texto");
});

test("a lista numerada virou lista", () => {
  assert.ok(quebrada.includes("<ol>") || quebrada.includes("<ul>"), "nenhuma lista");
});

test("a nota que já estava correta não foi alterada", () => {
  // O controle tem diagrama, tabela e títulos. Se a normalização mexesse em
  // conteúdo íntegro, é aqui que apareceria.
  assert.ok(controle.includes('<pre class="mermaid">'), "o diagrama sumiu");
  assert.ok(controle.includes("<h2>"), "os títulos sumiram");
  assert.ok(!controle.includes("&lt;"), "algo virou texto escapado");
});

test("HTML perigoso continua escapado", () => {
  // A correção converte só tabela. Habilitar html:true resolveria a tabela e
  // abriria a porta para um PDF de terceiro injetar script pelo modelo.
  const perigo = render({
    ...dados,
    notas: [
      {
        ...dados.notas[0],
        conteudo: "Texto <script>alert(1)</script> e <img src=x onerror=alert(1)>.",
      },
      dados.notas[1],
    ],
  });
  const ini = perigo.indexOf('<section id="sem-quebras"');
  const nota = perigo.slice(ini, perigo.indexOf("</section>", ini));

  // Procurar a substring "onerror=alert" acusaria também a forma escapada,
  // que é inofensiva. O que importa é se virou tag de verdade.
  assert.ok(!/<script/i.test(nota), "tag <script> real no documento");
  assert.ok(!/<img/i.test(nota), "tag <img> real no documento");
  assert.ok(nota.includes("&lt;script&gt;"), "o script deveria estar escapado e visível como texto");
});
