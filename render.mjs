/**
 * render.mjs — transforma o JSON de notas no HTML final.
 *
 * Não fala com IA nenhuma. Recebe um objeto já validado e devolve o HTML
 * completo, preenchendo os marcadores do template.html.
 *
 * É de propósito que esta camada seja burra e testável: rodando com um
 * exemplo.json escrito à mão, o pipeline inteiro (grafo, sidebar, mermaid,
 * navegação) fica provado antes de a IA entrar em cena.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";

const AQUI = dirname(fileURLToPath(import.meta.url));

/**
 * A marca do Weave: teia radial em dourado sobre preto.
 *
 * Vai como SVG embutido num `data:` — o HTML gerado precisa funcionar offline
 * e sozinho, então nenhum arquivo externo. O traço é grosso de propósito: a
 * marca vive a 16px na aba do navegador, e desenho fino some nesse tamanho.
 */
const LOGO_PADRAO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#08080a"/>' +
      '<g fill="none" stroke="#c6a15b" stroke-linecap="round" stroke-linejoin="round">' +
      '<path stroke-width="1.7" d="M16,16L16,3M16,16L27.3,9.5M16,16L27.3,22.5' +
      'M16,16L16,29M16,16L4.7,22.5M16,16L4.7,9.5"/>' +
      '<path stroke-width="1.45" d="M16,9.5Q18.5,11.6 21.6,12.8Q21.1,16 21.6,19.3' +
      "Q18.5,20.4 16,22.5Q13.5,20.4 10.4,19.3Q10.9,16 10.4,12.8Q13.5,11.6 16,9.5" +
      "M16,5Q20.3,8.6 25.5,10.5Q24.6,16 25.5,21.5Q20.3,23.4 16,27" +
      'Q11.7,23.4 6.5,21.5Q7.4,16 6.5,10.5Q11.7,8.6 16,5"/></g></svg>',
  );

// Extremos do degradê dourado usado nas categorias.
// Não começa no dourado mais escuro possível: sobre fundo preto, a bolinha de
// 9px da legenda precisa continuar visível na primeira categoria.
const COR_ESCURA = [0x9a, 0x78, 0x38];
const COR_CLARA = [0xea, 0xdf, 0xc0];

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/**
 * Conserta rótulos de nó que quebram o parser do mermaid.
 *
 * O modelo escreve coisas como `C[Justiça Comum (Federal ou Estadual)]`, e os
 * parênteses soltos dentro dos colchetes derrubam o diagrama inteiro — vira um
 * quadro de erro no lugar do desenho. A saída do modelo é imprevisível por
 * natureza, então o prompt pede rótulo limpo mas quem garante é aqui.
 *
 * A correção é a canônica do mermaid: envolver o rótulo em aspas. Preserva o
 * texto como o modelo escreveu, em vez de apagar informação.
 */
function saneiaMermaid(codigo) {
  const envolve = (abre, fecha) =>
    new RegExp(`\\${abre}([^\\${fecha}\\n]*)\\${fecha}`, "g");

  let saida = codigo;
  for (const [abre, fecha] of [
    ["[", "]"],
    ["{", "}"],
  ]) {
    saida = saida.replace(envolve(abre, fecha), (todo, rotulo) => {
      if (/^\s*".*"\s*$/.test(rotulo)) return todo; // já entre aspas
      if (!/[(){}[\]]/.test(rotulo)) return todo; // não precisa de aspas
      return `${abre}"${rotulo.replace(/"/g, "'")}"${fecha}`;
    });
  }
  return saida;
}

/**
 * Converte tabela escrita em HTML para tabela markdown.
 *
 * O modelo às vezes devolve `<table><tr><th>...` em vez do formato markdown.
 * Como o markdown-it roda com `html: false`, essas tags são escapadas e a
 * pessoa vê `&lt;table&gt;` como texto na tela — foi o defeito relatado.
 *
 * A correção óbvia seria ligar `html: true`, e ela é a errada: o conteúdo vem
 * de um modelo lendo o PDF de um terceiro, e um PDF pode carregar instruções
 * que façam o modelo emitir `<script>`. Aqui se converte só o que se
 * reconhece, e o resto continua escapado.
 */
function tabelasHtmlParaMarkdown(texto) {
  const inline = (s) =>
    s
      .replace(/<\s*br\s*\/?\s*>/gi, " ")
      .replace(/<\/?\s*(strong|b)\s*>/gi, "**")
      .replace(/<\/?\s*(em|i)\s*>/gi, "*")
      .replace(/<\/?\s*code\s*>/gi, "`")
      .replace(/<[^>]*>/g, "") // qualquer outra tag some
      .replace(/\|/g, "\\|") // pipe no texto quebraria a coluna
      .replace(/\s+/g, " ")
      .trim();

  return texto.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (todo, dentro) => {
    const linhas = [...dentro.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2])),
    );
    if (linhas.length < 2) return todo; // não parece tabela; deixa como está

    const colunas = Math.max(...linhas.map((l) => l.length));
    const preenche = (l) => [...l, ...Array(colunas - l.length).fill("")];
    const [cabecalho, ...corpo] = linhas.map(preenche);

    return (
      "\n\n" +
      `| ${cabecalho.join(" | ")} |\n` +
      `|${" --- |".repeat(colunas)}\n` +
      corpo.map((l) => `| ${l.join(" | ")} |`).join("\n") +
      "\n\n"
    );
  });
}

/**
 * Reconstrói os blocos de markdown quando o modelo devolveu tudo numa linha só.
 *
 * Sem `\n`, o markdown-it trata o conteúdo inteiro como um parágrafo: aplica as
 * regras inline (negrito vira `<strong>`) e ignora as de bloco, então `##` e
 * `1.` ficam como texto literal na tela. Medido no material da Prof. Nelma:
 * 12 das 29 notas voltaram assim.
 *
 * Só é chamada para conteúdo comprovadamente sem quebras — as heurísticas aqui
 * são agressivas de propósito, e aplicá-las a texto íntegro criaria quebras
 * onde não deve.
 */
function reconstroiBlocos(texto) {
  const minuscula = "a-záàâãéêíóôõúüç";
  const maiuscula = "A-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ";

  return (
    texto
      // "...fundamentais.## Classificação" → quebra antes do título
      .replace(new RegExp(`([^\\n])(#{2,6}\\s+)`, "g"), "$1\n\n$2")
      // "## Classificação do Direito ConstitucionalO Direito..." → o título
      // termina onde uma minúscula encosta numa maiúscula sem espaço, que é
      // exatamente onde a quebra de linha foi removida.
      .replace(
        new RegExp(`(\\n#{2,6} [^\\n]*?[${minuscula}])([${maiuscula}])`, "g"),
        "$1\n\n$2",
      )
      // "três tipos:1.  Direito..." → item de lista numerada
      .replace(
        new RegExp(`([^\\n\\d])(\\d{1,2}\\.\\s+)(?=[*\`${maiuscula}])`, "g"),
        "$1\n$2",
      )
      // "...são:- Primeira" → item de lista com marcador
      .replace(new RegExp(`([:.;])\\s*([-*]\\s+)(?=[*\`${maiuscula}])`, "g"), "$1\n$2")
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Deixa o markdown do modelo em forma antes de renderizar.
 *
 * Segue a regra que este projeto já aprendeu duas vezes: o prompt pede o
 * formato certo, mas quem garante é o código. Saída de modelo é imprevisível
 * por natureza, e o custo de uma nota ilegível é alto demais para depender
 * só de instrução.
 */
function normalizaMarkdown(texto) {
  const t = String(texto ?? "");

  // Detecta ANTES de converter tabelas, porque a conversão insere quebras e
  // apagaria a evidência de que o conteúdo veio quebrado.
  const semQuebras = !t.includes("\n") && t.length > 200;

  const comTabelas = tabelasHtmlParaMarkdown(t);
  return semQuebras ? reconstroiBlocos(comTabelas) : comTabelas;
}

// O template estiliza `pre.mermaid` e o mermaid.initialize() procura essa
// classe. Sem esta regra os diagramas sairiam como bloco de código comum.
md.renderer.rules.fence = (tokens, idx, _opts, _env, self) => {
  const token = tokens[idx];
  const lang = (token.info || "").trim().split(/\s+/)[0];
  if (lang === "mermaid") {
    return `<pre class="mermaid">${escapaHtml(saneiaMermaid(token.content))}</pre>\n`;
  }
  return self.renderToken(tokens, idx, _opts);
};

function escapaHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Interpola o degradê dourado conforme a quantidade de grupos. */
function coresPorGrupo(grupos) {
  const cores = {};
  const n = grupos.length;
  grupos.forEach((grupo, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    const canal = (a, b) => Math.round(a + (b - a) * t);
    const hex = [0, 1, 2]
      .map((c) => canal(COR_ESCURA[c], COR_CLARA[c]).toString(16).padStart(2, "0"))
      .join("");
    cores[grupo] = `#${hex.toUpperCase()}`;
  });
  return cores;
}

/**
 * Valida o JSON antes de renderizar.
 *
 * Existe porque o grafo descarta silenciosamente links cujo id não existe
 * (template.html, `.filter(l => l.source && l.target)`). Sem esta checagem
 * um erro do modelo viraria "o grafo saiu meio vazio" em vez de uma
 * mensagem dizendo o que deu errado.
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
  }

  // Ids órfãos em 'relacionado' são o modo de falha mais provável do modelo.
  for (const nota of dados.notas) {
    for (const alvo of nota.relacionado ?? []) {
      if (!ids.has(alvo))
        erros.push(`nota '${nota.id}': relacionado aponta para id inexistente '${alvo}'`);
    }
  }
  return erros;
}

/** Monta nodes/links no formato que o grafo do template consome. */
function montaGrafo(dados) {
  const nodes = [
    { id: "home", label: "🏠 Home", group: dados.grupos[0] },
    ...dados.notas.map((n) => ({ id: n.id, label: n.titulo, group: n.grupo })),
  ];

  const links = [];
  const vistos = new Set();
  const adiciona = (a, b) => {
    if (a === b) return;
    // O grafo é não-direcionado: A-B e B-A são a mesma aresta.
    const chave = [a, b].sort().join(" ");
    if (vistos.has(chave)) return;
    vistos.add(chave);
    links.push({ source: a, target: b });
  };

  // Home ligado a todas as notas — é isso que dá ao grafo o miolo denso.
  for (const nota of dados.notas) adiciona("home", nota.id);
  for (const nota of dados.notas)
    for (const alvo of nota.relacionado ?? []) adiciona(nota.id, alvo);

  return { group_order: dados.grupos, nodes, links };
}

function montaSidebar(dados) {
  return dados.grupos
    .map((grupo) => {
      const doGrupo = dados.notas.filter((n) => n.grupo === grupo);
      if (!doGrupo.length) return "";
      const links = doGrupo
        .map(
          (n) =>
            `<a class="nav-link" href="#${n.id}" data-slug="${n.id}">${escapaHtml(n.titulo)}</a>`,
        )
        .join("");
      return `<div class="nav-grupo"><div class="nav-grupo-tit">${escapaHtml(grupo)}</div>${links}</div>`;
    })
    .join("");
}

/** Seção inicial: índice clicável, agrupado — o "mapa" em forma de lista. */
function montaHome(dados) {
  const indice = dados.grupos
    .map((grupo) => {
      const doGrupo = dados.notas.filter((n) => n.grupo === grupo);
      if (!doGrupo.length) return "";
      const itens = doGrupo
        .map((n) => {
          const resumo = n.resumo ? ` — ${escapaHtml(n.resumo)}` : "";
          return `<li><a href="#${n.id}">${escapaHtml(n.titulo)}</a>${resumo}</li>`;
        })
        .join("");
      return `<h3>${escapaHtml(grupo)}</h3>\n<ul>${itens}</ul>`;
    })
    .join("\n");

  const sub = dados.subtitulo ? `<blockquote><p>${escapaHtml(dados.subtitulo)}</p></blockquote>` : "";
  return (
    `<section id="home" class="nota"><div class="nota-crumb">Início</div>` +
    `<h1>🧠 ${escapaHtml(dados.titulo)}</h1>\n${sub}\n` +
    `<p>Toque no botão 🕸️ no topo para abrir o gráfico. Cada bolinha é uma nota; ` +
    `o tamanho reflete quantas conexões ela tem.</p>\n` +
    `<h2>🗺️ Mapa</h2>\n${indice}\n</section>`
  );
}

function montaSecoes(dados) {
  const notas = dados.notas
    .map((n) => {
      const corpo = md.render(normalizaMarkdown(n.conteudo));
      const relacionadas = (n.relacionado ?? [])
        .map((alvo) => {
          const outra = dados.notas.find((x) => x.id === alvo);
          return outra ? `<a href="#${alvo}">${escapaHtml(outra.titulo)}</a>` : null;
        })
        .filter(Boolean);
      const bloco = relacionadas.length
        ? `<h2>Relacionado</h2>\n<p>${relacionadas.join(" · ")}</p>\n`
        : "";
      return (
        `<section id="${n.id}" class="nota">` +
        `<div class="nota-crumb">${escapaHtml(n.grupo)}</div>` +
        `<h1>${escapaHtml(n.titulo)}</h1>\n${corpo}${bloco}</section>`
      );
    })
    .join("\n");
  return montaHome(dados) + "\n" + notas;
}

/**
 * Preenche o template. Usa função de substituição em vez de string literal
 * porque `$&`, `$1` etc. dentro do conteúdo seriam interpretados como
 * referências de captura e corromperiam o HTML silenciosamente.
 */
function preenche(template, valores) {
  let out = template;
  for (const [chave, valor] of Object.entries(valores)) {
    out = out.replaceAll(`{{${chave}}}`, () => valor);
  }
  return out;
}

export function render(dados, { template } = {}) {
  const erros = valida(dados);
  if (erros.length) {
    const e = new Error(`JSON inválido:\n  - ${erros.join("\n  - ")}`);
    e.erros = erros;
    throw e;
  }

  const tpl = template ?? readFileSync(join(AQUI, "template.html"), "utf8");
  const n = dados.notas.length;

  return preenche(tpl, {
    TITULO: escapaHtml(dados.titulo),
    SUBTITULO: escapaHtml(dados.subtitulo ?? `${n} nota${n === 1 ? "" : "s"}`),
    LOGO_SRC: dados.logo ?? LOGO_PADRAO,
    SIDEBAR: montaSidebar(dados),
    SECOES: montaSecoes(dados),
    GRAPH_DATA: JSON.stringify(montaGrafo(dados)),
    GROUP_COLORS: JSON.stringify(coresPorGrupo(dados.grupos)),
  });
}
