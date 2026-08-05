/**
 * mapa.mjs — o formato da teia, e as regras que ele tem de obedecer.
 *
 * Antes disto o mapa era `{ titulo, subtitulo, grupos[], notas[] }` e não havia
 * registro nenhum de DE ONDE cada nota veio. Com uma fonte só isso não fazia
 * falta; com várias, é o produto inteiro — o que o Weave promete é justamente
 * mostrar onde materiais diferentes falam da mesma coisa.
 *
 *   {
 *     titulo, subtitulo,
 *     grupos: ["..."],
 *     fontes: [{ id, nome, tipo, quando, hash }],
 *     notas:  [{ id, titulo, grupo, resumo, conteudo, relacionado[], fontes[] }]
 *   }
 *
 * O `hash` de cada fonte serve a uma coisa só: recusar o mesmo arquivo tecido
 * duas vezes, que duplicaria notas e queimaria cota à toa.
 *
 * Este arquivo não renderiza e não chama IA. É a definição do formato, para
 * que `render.mjs`, `servidor.mjs` e `ia.mjs` concordem sobre o que é um mapa
 * válido em vez de cada um ter a sua ideia.
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";

/** Tipos de fonte que o Weave sabe receber. Ver `fontes.mjs`. */
export const TIPOS = ["pdf", "txt", "md", "csv", "xlsx", "docx"];

export const sha1 = (dados) => createHash("sha1").update(dados).digest("hex");

export function tipoPeloNome(nome = "") {
  const ext = extname(String(nome)).slice(1).toLowerCase();
  return TIPOS.includes(ext) ? ext : "txt";
}

/**
 * Próximo id de fonte livre: f1, f2, f3…
 *
 * Conta a partir do maior número já usado, e não do tamanho da lista, para que
 * apagar uma fonte no meio não faça a próxima reaproveitar um id aposentado —
 * as notas continuariam apontando para ele.
 */
export function proximoIdDeFonte(fontes = []) {
  const maior = fontes.reduce((m, f) => {
    const n = Number(String(f.id ?? "").replace(/^f/, ""));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `f${maior + 1}`;
}

/**
 * Põe um mapa antigo no formato novo.
 *
 * Roda na LEITURA, não como migração no banco: mapas antigos também chegam
 * pela linha de comando (`--json saida/dpc2.json`), onde não há banco nenhum
 * para migrar. Fazer aqui cobre os dois caminhos com um código só.
 *
 * Não mexe no que já está certo — um mapa novo passa por aqui inalterado.
 */
export function normalizaMapa(bruto, { nome, tipo, quando, hash } = {}) {
  const mapa = structuredClone(bruto);

  if (!Array.isArray(mapa.fontes) || !mapa.fontes.length) {
    const primeiro = nome ?? "fonte original";
    mapa.fontes = [
      {
        id: "f1",
        nome: primeiro,
        tipo: tipo ?? tipoPeloNome(primeiro),
        quando: quando ?? null,
        hash: hash ?? null,
      },
    ];
  }

  const padrao = mapa.fontes[0].id;
  for (const nota of mapa.notas ?? []) {
    if (!Array.isArray(nota.fontes) || !nota.fontes.length) nota.fontes = [padrao];
  }
  return mapa;
}

/** Notas sustentadas por duas ou mais fontes — o destaque do grafo sai daqui. */
export const ehCruzamento = (nota) => (nota.fontes?.length ?? 0) > 1;

/**
 * Confere o mapa inteiro e devolve a lista de problemas (vazia = está bom).
 *
 * Ids órfãos em `relacionado` são o modo de falha mais provável do modelo, e
 * ficaram ainda mais prováveis depois que tecer passou a juntar notas novas às
 * antigas. Por isso esta função precisa rodar DEPOIS da junção, e não só na
 * geração inicial.
 */
export function valida(dados) {
  const erros = [];
  if (!dados || typeof dados !== "object") return ["JSON raiz não é um objeto"];
  if (!dados.titulo) erros.push("falta 'titulo'");
  if (!Array.isArray(dados.grupos) || dados.grupos.length === 0)
    erros.push("'grupos' precisa ser uma lista não vazia");
  if (!Array.isArray(dados.notas) || dados.notas.length === 0)
    erros.push("'notas' precisa ser uma lista não vazia");
  if (erros.length) return erros;

  const grupos = new Set(dados.grupos);
  const ids = new Set();

  // Mapa sem 'fontes' é mapa antigo: quem lê deve passar por normalizaMapa()
  // antes. Aqui é erro, para o esquecimento aparecer no teste e não na tela.
  const fontes = new Set((dados.fontes ?? []).map((f) => f.id));
  if (!fontes.size) erros.push("falta 'fontes' — rode normalizaMapa() antes de validar");

  for (const [i, fonte] of (dados.fontes ?? []).entries()) {
    if (!fonte.id) erros.push(`fontes[${i}]: falta 'id'`);
    if (!fonte.nome) erros.push(`fontes[${i}]: falta 'nome'`);
  }

  for (const [i, nota] of dados.notas.entries()) {
    const onde = `notas[${i}]`;
    if (!nota.id) {
      erros.push(`${onde}: falta 'id'`);
      continue;
    }
    if (nota.id === "home") erros.push(`${onde}: id 'home' é reservado`);
    if (ids.has(nota.id)) erros.push(`${onde}: id duplicado '${nota.id}'`);
    ids.add(nota.id);
    if (!nota.titulo) erros.push(`${onde} (${nota.id}): falta 'titulo'`);
    if (!nota.grupo) erros.push(`${onde} (${nota.id}): falta 'grupo'`);
    else if (!grupos.has(nota.grupo))
      erros.push(`${onde} (${nota.id}): grupo '${nota.grupo}' não está em 'grupos'`);

    for (const f of nota.fontes ?? []) {
      if (!fontes.has(f))
        erros.push(`${onde} (${nota.id}): fonte '${f}' não está em 'fontes'`);
    }
  }

  for (const nota of dados.notas) {
    for (const alvo of nota.relacionado ?? []) {
      if (!ids.has(alvo))
        erros.push(`nota '${nota.id}': relacionado aponta para id inexistente '${alvo}'`);
    }
  }

  // Fonte declarada que não sustenta nota nenhuma é sintoma, não detalhe: quer
  // dizer que um arquivo foi enviado, pago e não rendeu nada no mapa.
  const usadas = new Set(dados.notas.flatMap((n) => n.fontes ?? []));
  for (const f of dados.fontes ?? []) {
    if (f.id && !usadas.has(f.id))
      erros.push(`fonte '${f.id}' (${f.nome}) não sustenta nota nenhuma`);
  }

  return erros;
}
