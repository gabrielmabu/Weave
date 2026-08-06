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
 * Junta o que a fonte nova rendeu ao mapa que já existia.
 *
 * É AQUI que nasce o defeito mais provável de todo o app: ligação apontando
 * para id inexistente. O modelo cita ids que leu no índice, ids que ele mesmo
 * acabou de inventar, e às vezes ids que não são nem uma coisa nem outra. Por
 * isso esta função devolve o mapa E um relatório do que ela teve de descartar,
 * e por isso `valida()` precisa rodar DEPOIS dela — não só na geração inicial.
 *
 * Os ids novos ganham prefixo da fonte (`f2-prazo`): sem isso, uma nota nova
 * chamada `prazo` colidiria com a `prazo` que já existe e uma sobrescreveria a
 * outra em silêncio.
 */
export function juntaMapa(base, { fonte, notasNovas = [], gruposNovos = [], reforcos = [] }) {
  const mapa = structuredClone(base);
  const relatorio = { novas: 0, reforcadas: 0, ligacoes: 0, descartadas: 0, ilhas: [] };

  mapa.fontes = [...(mapa.fontes ?? []), fonte];
  const idsAntigos = new Set(mapa.notas.map((n) => n.id));

  // Prefixo por fonte, resolvido antes de qualquer ligação ser lida: as
  // ligações citam os ids ORIGINAIS que o modelo devolveu, então é preciso
  // saber de antemão em que cada um deles se transformou.
  const renomeado = new Map();
  for (const nota of notasNovas) {
    if (!nota?.id || !nota.titulo || !nota.grupo) continue;
    let novo = `${fonte.id}-${nota.id}`;
    // Coincidência dupla é improvável, mas silenciosa se acontecer.
    while (idsAntigos.has(novo) || [...renomeado.values()].includes(novo)) novo += "-2";
    renomeado.set(nota.id, novo);
  }

  /**
   * Grupo novo entra renumerado, continuando a sequência.
   *
   * O modelo devolve nomes no formato `NN - Tema` sem saber quais números já
   * existem, e o resultado medido foi um segundo "06" e um "14" num mapa que
   * ia só até 07. Na legenda isso aparece como dois grupos com o mesmo número
   * e um salto sem explicação — e o prompt pedir "use os que já existem" não
   * resolve, porque prompt é conselho e código é garantia.
   */
  const numeroDe = (g) => Number(String(g).match(/^\s*(\d+)/)?.[1] ?? NaN);
  let maiorNumero = mapa.grupos.reduce((m, g) => {
    const n = numeroDe(g);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);

  const renomeadoGrupo = new Map();
  const registraGrupo = (bruto) => {
    if (!bruto) return null;
    if (renomeadoGrupo.has(bruto)) return renomeadoGrupo.get(bruto);
    if (mapa.grupos.includes(bruto)) { renomeadoGrupo.set(bruto, bruto); return bruto; }

    const semNumero = String(bruto).replace(/^\s*\d+\s*-\s*/, "").trim();
    // Mesmo tema com outro número é o mesmo grupo — juntar evita a legenda
    // ganhar "Recursos" duas vezes só porque a numeração veio diferente.
    const jaExiste = mapa.grupos.find(
      (g) => g.replace(/^\s*\d+\s*-\s*/, "").trim().toLowerCase() === semNumero.toLowerCase(),
    );
    const final = jaExiste ?? `${String(++maiorNumero).padStart(2, "0")} - ${semNumero}`;
    if (!jaExiste) mapa.grupos.push(final);
    renomeadoGrupo.set(bruto, final);
    return final;
  };

  for (const g of gruposNovos) registraGrupo(g);

  for (const nota of notasNovas) {
    const id = renomeado.get(nota.id);
    if (!id) continue;

    // Grupo que o modelo citou sem declarar em gruposNovos: em vez de
    // descartar a nota, adota o grupo (renumerado). Perder conteúdo pago por
    // um descuido de formato seria pior do que ganhar um grupo a mais.
    const grupo = registraGrupo(nota.grupo);

    const antes = nota.relacionado?.length ?? 0;
    const ligacoes = [];
    for (const alvo of nota.relacionado ?? []) {
      const resolvido = renomeado.get(alvo) ?? (idsAntigos.has(alvo) ? alvo : null);
      if (resolvido && resolvido !== id && !ligacoes.includes(resolvido)) ligacoes.push(resolvido);
    }
    relatorio.descartadas += antes - ligacoes.length;
    relatorio.ligacoes += ligacoes.filter((a) => idsAntigos.has(a)).length;

    // Nota nova sem nenhuma ligação para o mapa antigo é uma ilha: fica
    // pendurada sem se ligar a nada, e o gráfico mostra isso como um satélite
    // solto. Vale relatar em vez de esconder.
    if (!ligacoes.some((a) => idsAntigos.has(a))) relatorio.ilhas.push(id);

    mapa.notas.push({
      id,
      titulo: nota.titulo,
      grupo,
      resumo: nota.resumo ?? "",
      conteudo: nota.conteudo ?? "",
      relacionado: ligacoes,
      fontes: [fonte.id],
    });
    relatorio.novas++;
  }

  // Reforço: a nota continua a mesma, mas passa a ser sustentada por mais uma
  // fonte. É o que faz o nó virar cruzamento e ganhar destaque no gráfico.
  const porId = new Map(mapa.notas.map((n) => [n.id, n]));
  for (const r of reforcos) {
    const nota = porId.get(r?.id);
    if (!nota || !idsAntigos.has(r.id)) continue; // ignora reforço de nota que não existia
    if (!nota.fontes.includes(fonte.id)) {
      nota.fontes.push(fonte.id);
      relatorio.reforcadas++;
    }
  }

  return { mapa, relatorio };
}

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
