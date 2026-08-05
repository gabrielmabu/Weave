/**
 * Testes do armazenamento de teias — na implementação local.
 *
 * A propriedade que importa aqui é o isolamento entre contas. Uma teia é um
 * arquivo de estudo inteiro; se a rota errada devolvesse a de outra pessoa, o
 * vazamento seria o conteúdo completo, não um nome de arquivo.
 *
 * O dono é filtro dentro de `achaTeia`/`atualizaTeia`/`apagaTeia`, e não uma
 * comparação em quem chama, justamente para que uma rota futura que esqueça a
 * checagem continue não achando nada. É isso que estes testes fixam.
 *
 *   npm run teste
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abreArmazenamento } from "../armazenamento.mjs";

/** Um armazenamento local novo, em pasta temporária própria. */
function novo() {
  const pasta = mkdtempSync(join(tmpdir(), "weave-teste-"));
  const dados = abreArmazenamento({ ARQUIVO_DADOS: join(pasta, "dados.json") });
  return { dados, limpa: () => rmSync(pasta, { recursive: true, force: true }) };
}

const MAPA = {
  titulo: "Teste",
  grupos: ["A"],
  fontes: [{ id: "f1", nome: "a.pdf", tipo: "pdf" }],
  notas: [{ id: "n1", titulo: "Um", grupo: "A", relacionado: [], fontes: ["f1"] }],
};

test("teia criada aparece na lista do dono e some da dos outros", async () => {
  const { dados, limpa } = novo();
  try {
    const t = await dados.criaTeia({
      usuario_id: "ana", nome: "Processual Civil", objetivo: "prova", mapa: MAPA,
    });

    assert.equal((await dados.listaTeias("ana")).length, 1);
    assert.equal((await dados.listaTeias("bruno")).length, 0);
    assert.equal((await dados.achaTeia(t.id, "ana")).nome, "Processual Civil");
    assert.equal(await dados.achaTeia(t.id, "bruno"), null);
  } finally {
    limpa();
  }
});

test("dono errado não atualiza nem apaga", async () => {
  const { dados, limpa } = novo();
  try {
    const t = await dados.criaTeia({ usuario_id: "ana", nome: "Minha", mapa: MAPA });

    assert.equal(await dados.atualizaTeia(t.id, "bruno", { nome: "Roubada" }), null);
    assert.equal(await dados.apagaTeia(t.id, "bruno"), false);

    // E continua intacta para a dona.
    assert.equal((await dados.achaTeia(t.id, "ana")).nome, "Minha");
  } finally {
    limpa();
  }
});

test("atualizar mexe no mapa e no carimbo de tempo", async () => {
  const { dados, limpa } = novo();
  try {
    const t = await dados.criaTeia({ usuario_id: "ana", nome: "Minha", mapa: MAPA });
    const maior = structuredClone(MAPA);
    maior.notas.push({ id: "n2", titulo: "Dois", grupo: "A", relacionado: [], fontes: ["f1"] });

    // O relógio tem resolução de milissegundo; sem esperar, os dois carimbos
    // sairiam iguais e o teste passaria por acaso.
    await new Promise((r) => setTimeout(r, 5));
    const depois = await dados.atualizaTeia(t.id, "ana", { mapa: maior });

    assert.equal(depois.mapa.notas.length, 2);
    assert.ok(depois.atualizada_em > t.atualizada_em);
    assert.equal(depois.criada_em, t.criada_em);
  } finally {
    limpa();
  }
});

test("apagar tira da lista e é idempotente", async () => {
  const { dados, limpa } = novo();
  try {
    const t = await dados.criaTeia({ usuario_id: "ana", nome: "Minha", mapa: MAPA });
    assert.equal(await dados.apagaTeia(t.id, "ana"), true);
    assert.equal((await dados.listaTeias("ana")).length, 0);
    assert.equal(await dados.apagaTeia(t.id, "ana"), false);
  } finally {
    limpa();
  }
});

test("critérios são cacheados por objetivo e sobrescritos, não duplicados", async () => {
  const { dados, limpa } = novo();
  try {
    assert.equal(await dados.achaCriterios("passar na oab"), null);

    await dados.gravaCriterios("passar na oab", "primeiro texto");
    assert.equal((await dados.achaCriterios("passar na oab")).criterios, "primeiro texto");

    await dados.gravaCriterios("passar na oab", "texto revisado");
    assert.equal((await dados.achaCriterios("passar na oab")).criterios, "texto revisado");

    // Objetivo diferente é entrada diferente — o cache não pode confundir os dois.
    assert.equal(await dados.achaCriterios("explicar para leigo"), null);
  } finally {
    limpa();
  }
});
