#!/usr/bin/env node
/**
 * gerar.mjs — CLI do gerador.
 *
 *   node gerar.mjs apostila.pdf -o saida/apostila.html    (PDF -> IA -> HTML)
 *   node gerar.mjs --json exemplo.json -o saida/ex.html   (JSON -> HTML, sem IA)
 *
 * O modo --json existe para testar e ajustar o render sem gastar chamada de
 * API, e para reaproveitar o JSON de um PDF já processado.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename, extname } from "node:path";
import { render } from "./render.mjs";

function ajuda() {
  console.log(`
Cortex4U — transforma um PDF de estudo num mapa mental navegável.

  node gerar.mjs <arquivo.pdf> [-o saida.html]
  node gerar.mjs --json <arquivo.json> [-o saida.html]

Opções:
  -o, --saida <arquivo>    caminho do HTML gerado (padrão: <nome>.html)
      --objetivo "<texto>" para que serve o mapa — muda o que vira nota
      --json <arquivo>     pula a IA e renderiza um JSON pronto
      --salvar-json <arq>  grava o JSON intermediário produzido pela IA
      --paginas <n>        manda só as n primeiras páginas
      --lote <n>           notas por chamada (maior = mais barato)
      --estimar            mostra o custo previsto sem gastar nada
  -h, --ajuda              esta mensagem

O objetivo é o que mais muda o resultado. O mesmo PDF rende mapas diferentes:
  --objetivo "estudar os conceitos para a prova da OAB"
  --objetivo "explicar o processo para um cliente leigo"
`);
}

function parseArgs(argv) {
  const args = {
    entrada: null, saida: null, json: null, salvarJson: null,
    paginas: null, lote: null, estimar: false, objetivo: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--ajuda" || a === "--help") {
      ajuda();
      process.exit(0);
    } else if (a === "-o" || a === "--saida") {
      args.saida = argv[++i];
    } else if (a === "--json") {
      args.json = argv[++i];
    } else if (a === "--salvar-json") {
      args.salvarJson = argv[++i];
    } else if (a === "--objetivo") {
      args.objetivo = argv[++i];
    } else if (a === "--paginas") {
      args.paginas = Number(argv[++i]);
    } else if (a === "--lote") {
      args.lote = Number(argv[++i]);
    } else if (a === "--estimar") {
      args.estimar = true;
    } else if (a.startsWith("-")) {
      throw new Error(`opção desconhecida: ${a}`);
    } else if (!args.entrada) {
      args.entrada = a;
    } else {
      throw new Error(`argumento extra não esperado: ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fonte = args.json ?? args.entrada;

  if (!fonte) {
    ajuda();
    process.exit(1);
  }

  let dados;
  if (args.json) {
    let bruto;
    try {
      bruto = readFileSync(args.json, "utf8");
    } catch (e) {
      throw new Error(`não consegui ler ${args.json}: ${e.message}`);
    }
    try {
      dados = JSON.parse(bruto);
    } catch (e) {
      throw new Error(`${args.json} não é JSON válido: ${e.message}`);
    }
  } else {
    const { pdfParaNotas, estimativa } = await import("./ia.mjs");

    // --estimar responde "quanto isso vai custar?" sem gastar nada.
    if (args.estimar) {
      const e = await estimativa(args.entrada, { paginas: args.paginas, lote: args.lote });
      console.log(`\n${e.paginas} páginas · ${e.mb.toFixed(1)} MB`);
      console.log(`~${e.tokensPorChamada.toLocaleString("pt-BR")} tokens de entrada por chamada`);
      console.log(`estimativa para ${e.notasEstimadas} notas em lotes de ${e.lote}:`);
      console.log(`  ~${e.chamadas} chamadas · ~${e.tokensTotais.toLocaleString("pt-BR")} tokens de entrada\n`);
      return;
    }

    // Checkpoint ao lado da saída: se uma chamada falhar no meio, a próxima
    // execução retoma de onde parou em vez de repagar o que já deu certo.
    const saidaPrevista = args.saida ?? `${basename(fonte, extname(fonte))}.html`;
    dados = await pdfParaNotas(args.entrada, {
      checkpoint: `${saidaPrevista.replace(/\.html?$/i, "")}.checkpoint.json`,
      paginas: args.paginas,
      lote: args.lote,
      objetivo: args.objetivo,
    });
    if (args.salvarJson) {
      mkdirSync(dirname(args.salvarJson), { recursive: true });
      writeFileSync(args.salvarJson, JSON.stringify(dados, null, 2), "utf8");
      console.log(`JSON intermediário salvo em ${args.salvarJson}`);
    }
  }

  const saida = args.saida ?? `${basename(fonte, extname(fonte))}.html`;
  const html = render(dados);

  mkdirSync(dirname(saida) || ".", { recursive: true });
  writeFileSync(saida, html, "utf8");

  const kb = (html.length / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  console.log(`✓ ${saida}`);
  console.log(`  ${dados.notas.length} notas · ${dados.grupos.length} grupos · ${kb} KB`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
