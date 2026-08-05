/**
 * O pipeline inteiro, com a API simulada.
 *
 * Existe porque a alternativa para saber se uma fonte de texto chega direito à
 * Gemini seria gastar cota de verdade — e cota aqui é compartilhada com um app
 * em produção. Trocando o `fetch` por um dublê dá para conferir o que MAIS
 * importa e não se vê no resultado final: o que exatamente é enviado.
 *
 * O que estes testes fixam:
 *   - planilha e texto viajam como TEXTO, nunca como arquivo inline;
 *   - PDF viaja como inlineData;
 *   - as fontes são reenviadas em toda chamada (a API é sem estado) — é isso
 *     que explica o custo, e uma regressão aqui apareceria como conta alta;
 *   - o freio barra ANTES da primeira chamada, sem gastar nada.
 *
 *   npm run teste
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fontesParaNotas, estimativa, parteDaFonte } from "../ia.mjs";

const fetchDeVerdade = globalThis.fetch;
let enviados = [];

/** Responde como a Gemini responderia, e guarda o que foi pedido. */
function fingeGemini() {
  enviados = [];
  globalThis.fetch = async (_url, opcoes) => {
    const corpo = JSON.parse(opcoes.body);
    enviados.push(corpo);

    const prompt = corpo.contents[0].parts.at(-1).text;
    const resposta = /Notas deste lote/.test(prompt)
      ? { notas: [{ id: "n1", conteudo: "## Um\n\nCorpo da nota.\n" }] }
      : {
          titulo: "Mapa de teste",
          subtitulo: "1 nota",
          grupos: ["Geral"],
          notas: [{ id: "n1", titulo: "Um", grupo: "Geral", resumo: "recorte", relacionado: [] }],
        };

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(resposta) }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
        }),
    };
  };
}

let pasta;
beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), "weave-pipe-"));
  fingeGemini();
});
afterEach(() => {
  globalThis.fetch = fetchDeVerdade;
  rmSync(pasta, { recursive: true, force: true });
});

const escreve = (nome, conteudo) => {
  const c = join(pasta, nome);
  writeFileSync(c, conteudo);
  return c;
};

const opcoes = { apiKey: "chave-de-mentira", checkpoint: null, tetoTokens: 0 };

test("fonte de texto viaja como texto, nunca como arquivo inline", async () => {
  const caminho = escreve("aula.md", "# Aula 1\n\nCompetência é a medida da jurisdição.");
  const mapa = await fontesParaNotas([{ caminho, nome: "aula.md" }], opcoes);

  assert.equal(mapa.notas.length, 1);
  assert.equal(mapa.notas[0].conteudo, "## Um\n\nCorpo da nota.\n");

  for (const corpo of enviados) {
    const partes = corpo.contents[0].parts;
    assert.ok(!partes.some((p) => p.inlineData), "não deveria haver arquivo inline");
    // O nome vai junto: com várias fontes, é como o modelo sabe onde uma
    // acaba e a outra começa para dizer que um conceito apareceu nas duas.
    assert.match(partes[0].text, /^### Fonte: aula\.md \(md\)/);
    assert.match(partes[0].text, /medida da jurisdição/);
  }
});

test("PDF viaja como inlineData", () => {
  const parte = parteDaFonte({ tipo: "pdf", nome: "a.pdf", pdf: Buffer.from("%PDF-1.4 x") });
  assert.equal(parte.inlineData.mimeType, "application/pdf");
  assert.equal(Buffer.from(parte.inlineData.data, "base64").toString(), "%PDF-1.4 x");
  assert.equal(parte.text, undefined);
});

test("as fontes são reenviadas em TODA chamada", async () => {
  // A API não tem estado. É daqui que vem ~90% do custo de entrada, e é o que
  // justifica os lotes: perder isto de vista é como a conta dispara sem aviso.
  const caminho = escreve("a.txt", "conteúdo qualquer");
  await fontesParaNotas([{ caminho, nome: "a.txt" }], opcoes);

  assert.equal(enviados.length, 2, "esperava uma chamada de índice e uma de conteúdo");
  for (const corpo of enviados) {
    assert.match(corpo.contents[0].parts[0].text, /### Fonte: a\.txt/);
  }
});

test("duas fontes chegam juntas e identificadas", async () => {
  const a = escreve("apostila.txt", "texto da apostila");
  const b = escreve("exercicios.csv", "questao,gabarito\n1,C\n");
  await fontesParaNotas(
    [{ caminho: a, nome: "apostila.txt" }, { caminho: b, nome: "exercicios.csv" }],
    opcoes,
  );

  const partes = enviados[0].contents[0].parts;
  assert.equal(partes.length, 3); // duas fontes + o prompt
  assert.match(partes[0].text, /### Fonte: apostila\.txt \(txt\)/);
  assert.match(partes[1].text, /### Fonte: exercicios\.csv \(csv\)/);
  assert.match(partes[1].text, /\| questao \| gabarito \|/);
});

test("o freio barra antes da primeira chamada, sem gastar nada", async () => {
  const caminho = escreve("grande.txt", "x".repeat(200_000)); // ~50 mil tokens
  await assert.rejects(
    () => fontesParaNotas([{ caminho, nome: "grande.txt" }], { ...opcoes, tetoTokens: 1000 }),
    /passa do teto/,
  );
  assert.equal(enviados.length, 0, "não podia ter chamado a API nenhuma vez");
});

test("a estimativa de fonte de texto é exata, não um palpite", async () => {
  const caminho = escreve("a.txt", "y".repeat(4000));
  const e = await estimativa([{ caminho, nome: "a.txt" }], { lote: 12 });

  assert.equal(e.paginas, 0);
  assert.equal(e.caracteres, 4000);
  assert.equal(e.tokensPorChamada, 1000); // 4000 / 4, sem arredondamento por página
});
