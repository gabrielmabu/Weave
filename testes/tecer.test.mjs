/**
 * Testes da junção — o ponto mais frágil do app.
 *
 * Juntar notas novas às antigas é exatamente onde nasce ligação apontando para
 * id inexistente. Quando isso escapa, a aresta some do gráfico SEM ERRO NENHUM
 * e o sintoma que chega ao usuário é "o mapa ficou ralo" — que não aponta para
 * a causa. Daí o número de casos aqui.
 *
 * O outro alvo é o custo. Tecer só é barato porque nenhuma passada reenvia as
 * fontes antigas; um teste com a API simulada fixa isso, porque uma regressão
 * apareceria como conta alta e não como teste vermelho.
 *
 *   npm run teste
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { juntaMapa, valida, normalizaMapa } from "../mapa.mjs";
import { tecerFonte } from "../ia.mjs";

const mapaAntigo = () =>
  normalizaMapa({
    titulo: "Processual Civil",
    grupos: ["01 - Competência", "02 - Recursos"],
    fontes: [{ id: "f1", nome: "apostila.pdf", tipo: "pdf", hash: "aaa" }],
    notas: [
      { id: "competencia", titulo: "Competência", grupo: "01 - Competência",
        resumo: "quem julga o quê", conteudo: "Texto antigo da competência.",
        relacionado: ["agravo"], fontes: ["f1"] },
      { id: "agravo", titulo: "Agravo", grupo: "02 - Recursos",
        resumo: "quando cabe agravo", conteudo: "Texto antigo do agravo.",
        relacionado: ["competencia"], fontes: ["f1"] },
    ],
  });

const fonteNova = { id: "f2", nome: "aula.txt", tipo: "txt", hash: "bbb", quando: "2026-08-05T00:00:00Z" };

// ------------------------------------------------------------------ junção

test("nota nova entra com prefixo da fonte e liga no mapa antigo", () => {
  const { mapa, relatorio } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    notasNovas: [
      { id: "conflito", titulo: "Conflito de competência", grupo: "01 - Competência",
        resumo: "quando dois juízos se declaram", relacionado: ["competencia"] },
    ],
    reforcos: [],
  });

  assert.deepEqual(valida(mapa), []);
  const nova = mapa.notas.find((n) => n.titulo === "Conflito de competência");
  assert.equal(nova.id, "f2-conflito");
  assert.deepEqual(nova.fontes, ["f2"]);
  assert.deepEqual(nova.relacionado, ["competencia"]);
  assert.equal(relatorio.ligacoes, 1);
  assert.equal(relatorio.ilhas.length, 0);
});

test("id novo que colide com um antigo não sobrescreve o antigo", () => {
  // Sem o prefixo, a nota nova apagaria a existente em silêncio — e o pior
  // desfecho de tecer é perder o que já estava lá.
  const { mapa } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    notasNovas: [
      { id: "agravo", titulo: "Agravo interno", grupo: "02 - Recursos",
        resumo: "outra coisa", relacionado: ["agravo"] },
    ],
    reforcos: [],
  });

  assert.equal(mapa.notas.length, 3);
  assert.equal(mapa.notas.find((n) => n.id === "agravo").conteudo, "Texto antigo do agravo.");
  assert.ok(mapa.notas.some((n) => n.id === "f2-agravo"));
  assert.deepEqual(valida(mapa), []);
});

test("ligação para id que não existe em lugar nenhum é descartada, não propagada", () => {
  const { mapa, relatorio } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    notasNovas: [
      { id: "nova", titulo: "Nova", grupo: "02 - Recursos", resumo: "x",
        relacionado: ["competencia", "id-que-o-modelo-inventou", "outra-nova"] },
      { id: "outra-nova", titulo: "Outra", grupo: "02 - Recursos", resumo: "y",
        relacionado: ["agravo"] },
    ],
    reforcos: [],
  });

  // O teste que realmente importa: o mapa resultante é válido.
  assert.deepEqual(valida(mapa), []);
  assert.equal(relatorio.descartadas, 1);

  const nova = mapa.notas.find((n) => n.id === "f2-nova");
  // A ligação para a outra nota nova foi reescrita para o id prefixado.
  assert.deepEqual(nova.relacionado, ["competencia", "f2-outra-nova"]);
});

test("reforço marca a nota antiga como sustentada por duas fontes", () => {
  const { mapa, relatorio } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    notasNovas: [],
    reforcos: [{ id: "competencia", porque: "a aula dá um exemplo concreto" }],
  });

  assert.deepEqual(mapa.notas.find((n) => n.id === "competencia").fontes, ["f1", "f2"]);
  assert.deepEqual(mapa.notas.find((n) => n.id === "agravo").fontes, ["f1"]);
  assert.equal(relatorio.reforcadas, 1);
  assert.deepEqual(valida(mapa), []);
});

test("reforço de nota inexistente é ignorado em vez de quebrar a junção", () => {
  const { mapa, relatorio } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    notasNovas: [{ id: "n", titulo: "N", grupo: "02 - Recursos", resumo: "z", relacionado: ["agravo"] }],
    reforcos: [{ id: "nao-existe", porque: "..." }],
  });
  assert.equal(relatorio.reforcadas, 0);
  assert.deepEqual(valida(mapa), []);
});

test("nota nova sem ligação com o mapa antigo é relatada como ilha", () => {
  // Não é erro — é uma nota pendurada sem se ligar a nada, e o gráfico mostra
  // isso como satélite solto. Vale aparecer no log em vez de passar batido.
  const { mapa, relatorio } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    notasNovas: [{ id: "solta", titulo: "Solta", grupo: "02 - Recursos", resumo: "w", relacionado: [] }],
    reforcos: [],
  });
  assert.deepEqual(relatorio.ilhas, ["f2-solta"]);
  assert.deepEqual(valida(mapa), []);
});

test("grupo novo entra na lista de grupos", () => {
  const { mapa } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    gruposNovos: ["03 - Execução"],
    notasNovas: [
      { id: "penhora", titulo: "Penhora", grupo: "03 - Execução", resumo: "x", relacionado: ["agravo"] },
    ],
    reforcos: [],
  });
  assert.ok(mapa.grupos.includes("03 - Execução"));
  assert.deepEqual(valida(mapa), []);
});

test("grupo citado mas não declarado é adotado, não descarta a nota", () => {
  // Perder conteúdo já pago por um descuido de formato do modelo seria pior
  // do que ganhar um grupo a mais na legenda.
  const { mapa } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    gruposNovos: [],
    notasNovas: [
      { id: "penhora", titulo: "Penhora", grupo: "03 - Execução", resumo: "x", relacionado: ["agravo"] },
    ],
    reforcos: [],
  });
  assert.ok(mapa.grupos.includes("03 - Execução"));
  assert.equal(mapa.notas.length, 3);
  assert.deepEqual(valida(mapa), []);
});

test("a junção não mexe no mapa de origem", () => {
  const antes = mapaAntigo();
  juntaMapa(antes, {
    fonte: fonteNova,
    notasNovas: [{ id: "n", titulo: "N", grupo: "02 - Recursos", resumo: "z", relacionado: ["agravo"] }],
    reforcos: [{ id: "agravo", porque: "..." }],
  });
  assert.equal(antes.notas.length, 2);
  assert.equal(antes.fontes.length, 1);
  assert.deepEqual(antes.notas.find((n) => n.id === "agravo").fontes, ["f1"]);
});

// -------------------------------------------------------- custo de tecer

const fetchDeVerdade = globalThis.fetch;
let enviados = [];
let pasta;

beforeEach(() => {
  pasta = mkdtempSync(join(tmpdir(), "weave-tecer-"));
  enviados = [];
  globalThis.fetch = async (_url, opcoes) => {
    const corpo = JSON.parse(opcoes.body);
    enviados.push(corpo);
    const prompt = corpo.contents[0].parts.at(-1).text;

    const resposta = /Índice do mapa atual/.test(prompt)
      ? {
          reforcos: [{ id: "competencia", porque: "a aula exemplifica" }],
          gruposNovos: [],
          notasNovas: [
            { id: "conflito", titulo: "Conflito", grupo: "01 - Competência",
              resumo: "x", relacionado: ["competencia"] },
          ],
        }
      : { notas: [{ id: "conflito", conteudo: "## Conflito\n\nTexto novo.\n" },
                   { id: "competencia", conteudo: "## Competência\n\nTexto enriquecido.\n" }] };

    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(resposta) }] } }],
        usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 500 },
      }),
    };
  };
});
afterEach(() => {
  globalThis.fetch = fetchDeVerdade;
  rmSync(pasta, { recursive: true, force: true });
});

const arquivoNovo = () => {
  const c = join(pasta, "aula.txt");
  writeFileSync(c, "A aula da professora sobre competência e conflito.");
  return c;
};

test("tecer NUNCA reenvia as fontes antigas", async () => {
  // É a propriedade que faz tecer custar ~21 mil em vez de ~129 mil. Se um dia
  // alguém mandar o material antigo junto, o teste quebra antes da fatura.
  const r = await tecerFonte(mapaAntigo(), [{ caminho: arquivoNovo(), nome: "aula.txt" }], {
    apiKey: "mentira", checkpoint: null, tetoTokens: 0,
  });

  assert.equal(r.notasNovas.length, 1);
  assert.equal(r.reforcos.length, 1);

  for (const corpo of enviados) {
    const texto = JSON.stringify(corpo.contents[0].parts);
    assert.match(texto, /aula\.txt/, "a fonte nova precisa ir em toda chamada");
    assert.ok(!/apostila\.pdf/.test(texto), "a fonte antiga não pode ser reenviada");
    assert.ok(!corpo.contents[0].parts.some((p) => p.inlineData), "nada de arquivo inline aqui");
  }
});

test("a passada 1 manda só o índice, não o texto das notas", async () => {
  // Mandar o conteúdo completo das 51 notas multiplicaria esta passada por dez
  // sem melhorar a decisão de "isto já existe no mapa?".
  await tecerFonte(mapaAntigo(), [{ caminho: arquivoNovo(), nome: "aula.txt" }], {
    apiKey: "mentira", checkpoint: null, tetoTokens: 0,
  });

  const primeira = enviados[0].contents[0].parts.at(-1).text;
  assert.match(primeira, /id: `competencia`/);
  assert.match(primeira, /quem julga o quê/);         // o recorte vai
  assert.ok(!/Texto antigo da competência/.test(primeira)); // o conteúdo não
});

test("a passada de enriquecer manda o texto ATUAL da nota que casou", async () => {
  await tecerFonte(mapaAntigo(), [{ caminho: arquivoNovo(), nome: "aula.txt" }], {
    apiKey: "mentira", checkpoint: null, tetoTokens: 0,
  });

  const enriquecer = enviados.map((c) => c.contents[0].parts.at(-1).text)
    .find((t) => /Notas a enriquecer/.test(t));
  assert.ok(enriquecer, "esperava uma passada de enriquecimento");
  assert.match(enriquecer, /Texto antigo da competência/);
  // Só a que casou. A outra nota não tem por que viajar.
  assert.ok(!/Texto antigo do agravo/.test(enriquecer));
});

test("tecer o mesmo arquivo de novo é recusado sem gastar chamada", async () => {
  const mapa = mapaAntigo();
  const caminho = arquivoNovo();
  const primeira = await tecerFonte(mapa, [{ caminho, nome: "aula.txt" }], {
    apiKey: "mentira", checkpoint: null, tetoTokens: 0,
  });

  const { mapa: depois } = juntaMapa(mapa, { ...primeira, fonte: { ...primeira.fonte, id: "f2" } });
  enviados = [];

  await assert.rejects(
    () => tecerFonte(depois, [{ caminho, nome: "aula.txt" }], {
      apiKey: "mentira", checkpoint: null, tetoTokens: 0,
    }),
    /já foi tecido nesta teia/,
  );
  assert.equal(enviados.length, 0, "não podia ter chamado a API");
});

// ------------------------------------------------------- numeração de grupos

test("grupo novo é renumerado para continuar a sequência", () => {
  // Medido numa tecelagem real: o mapa ia até "02 - Recursos" e o modelo
  // devolveu "06 - Competência" e "14 - Recursos". Na legenda isso aparece
  // como número repetido e salto sem explicação. O prompt pede para reusar os
  // grupos existentes, mas prompt é conselho — a garantia é aqui.
  const { mapa } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    gruposNovos: ["06 - Execução", "14 - Provas"],
    notasNovas: [
      { id: "a", titulo: "A", grupo: "06 - Execução", resumo: "x", relacionado: ["agravo"] },
      { id: "b", titulo: "B", grupo: "14 - Provas", resumo: "y", relacionado: ["agravo"] },
    ],
    reforcos: [],
  });

  assert.deepEqual(mapa.grupos, [
    "01 - Competência", "02 - Recursos", "03 - Execução", "04 - Provas",
  ]);
  assert.equal(mapa.notas.find((n) => n.id === "f2-a").grupo, "03 - Execução");
  assert.equal(mapa.notas.find((n) => n.id === "f2-b").grupo, "04 - Provas");
  assert.deepEqual(valida(mapa), []);
});

test("mesmo tema com outro número vira o grupo que já existe", () => {
  // Senão a legenda ganharia "Recursos" duas vezes só porque a numeração veio
  // diferente, e as notas do mesmo assunto ficariam em cores distintas.
  const { mapa } = juntaMapa(mapaAntigo(), {
    fonte: fonteNova,
    gruposNovos: ["09 - Recursos"],
    notasNovas: [
      { id: "c", titulo: "C", grupo: "09 - Recursos", resumo: "z", relacionado: ["agravo"] },
    ],
    reforcos: [],
  });

  assert.deepEqual(mapa.grupos, ["01 - Competência", "02 - Recursos"]);
  assert.equal(mapa.notas.find((n) => n.id === "f2-c").grupo, "02 - Recursos");
  assert.deepEqual(valida(mapa), []);
});
