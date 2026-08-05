/**
 * Testes do formato da teia.
 *
 * Duas coisas aqui não podem quebrar em silêncio:
 *
 *   - mapas gerados ANTES de as fontes existirem precisam continuar abrindo.
 *     Há JSONs pagos em saida/ e o app tem de renderizá-los;
 *   - a validação precisa pegar ligação para id inexistente. É o modo de falha
 *     mais provável do modelo, e tecer (que junta notas novas às antigas) só
 *     aumenta a chance. Quando escapa, a aresta some do grafo sem erro nenhum
 *     e o sintoma é "o mapa ficou ralo" — que não aponta para a causa.
 *
 *   npm run teste
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizaMapa, valida, proximoIdDeFonte, ehCruzamento, tipoPeloNome } from "../mapa.mjs";

const mapaBase = () => ({
  titulo: "Teste",
  grupos: ["A", "B"],
  fontes: [
    { id: "f1", nome: "apostila.pdf", tipo: "pdf" },
    { id: "f2", nome: "aula.txt", tipo: "txt" },
  ],
  notas: [
    { id: "n1", titulo: "Um", grupo: "A", relacionado: ["n2"], fontes: ["f1"] },
    { id: "n2", titulo: "Dois", grupo: "B", relacionado: [], fontes: ["f1", "f2"] },
  ],
});

test("mapa antigo, sem fontes, ganha uma fonte e todas as notas apontam para ela", () => {
  const antigo = {
    titulo: "Antigo",
    grupos: ["A"],
    notas: [{ id: "n1", titulo: "Um", grupo: "A", relacionado: [] }],
  };
  const novo = normalizaMapa(antigo, { nome: "apostila.pdf" });

  assert.equal(novo.fontes.length, 1);
  assert.equal(novo.fontes[0].id, "f1");
  assert.equal(novo.fontes[0].tipo, "pdf");
  assert.deepEqual(novo.notas[0].fontes, ["f1"]);
  assert.deepEqual(valida(novo), []);

  // Não pode mexer no original: quem chama pode ainda precisar dele.
  assert.equal(antigo.fontes, undefined);
});

test("mapa que já está no formato novo passa inalterado", () => {
  const antes = mapaBase();
  const depois = normalizaMapa(antes);
  assert.deepEqual(depois, antes);
});

test("o JSON real de 51 notas ainda valida depois de normalizado", () => {
  const dpc = JSON.parse(readFileSync(new URL("../saida/dpc2.json", import.meta.url), "utf8"));
  const mapa = normalizaMapa(dpc, { nome: "dpc2.pdf" });
  assert.deepEqual(valida(mapa), []);
  assert.equal(mapa.notas.length, 51);
});

test("valida recusa nota que cita fonte inexistente", () => {
  const m = mapaBase();
  m.notas[0].fontes = ["f9"];
  const erros = valida(m);
  assert.equal(erros.length, 1);
  assert.match(erros[0], /fonte 'f9' não está em 'fontes'/);
});

test("valida recusa fonte que não sustenta nota nenhuma", () => {
  // Sintoma de arquivo enviado, pago e que não rendeu nada no mapa.
  const m = mapaBase();
  m.notas[1].fontes = ["f1"];
  const erros = valida(m);
  assert.equal(erros.length, 1);
  assert.match(erros[0], /fonte 'f2' \(aula\.txt\) não sustenta nota nenhuma/);
});

test("valida continua pegando ligação para id inexistente", () => {
  const m = mapaBase();
  m.notas[0].relacionado = ["n2", "n404"];
  const erros = valida(m);
  assert.equal(erros.length, 1);
  assert.match(erros[0], /id inexistente 'n404'/);
});

test("valida cobra 'fontes' de quem não passou pela normalização", () => {
  const m = mapaBase();
  delete m.fontes;
  assert.ok(valida(m).some((e) => /rode normalizaMapa\(\) antes/.test(e)));
});

test("o próximo id de fonte não reaproveita id aposentado", () => {
  assert.equal(proximoIdDeFonte([]), "f1");
  assert.equal(proximoIdDeFonte([{ id: "f1" }, { id: "f2" }]), "f3");
  // f2 apagada: f3 continua sendo o próximo, senão as notas de f3 e as da
  // fonte nova se confundiriam.
  assert.equal(proximoIdDeFonte([{ id: "f1" }, { id: "f3" }]), "f4");
});

test("cruzamento é nota sustentada por mais de uma fonte", () => {
  const m = mapaBase();
  assert.equal(ehCruzamento(m.notas[0]), false);
  assert.equal(ehCruzamento(m.notas[1]), true);
});

test("o tipo sai da extensão, e o desconhecido cai em texto", () => {
  assert.equal(tipoPeloNome("a.PDF"), "pdf");
  assert.equal(tipoPeloNome("planilha.xlsx"), "xlsx");
  assert.equal(tipoPeloNome("sem-extensao"), "txt");
  assert.equal(tipoPeloNome("foto.png"), "txt");
});
