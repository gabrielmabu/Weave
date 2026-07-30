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

// Logo padrão: emoji em SVG, para o template não depender de arquivo externo.
const LOGO_PADRAO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<rect width="100" height="100" rx="20" fill="#0F6E56"/>' +
      '<text x="50" y="72" font-size="58" text-anchor="middle">🧠</text></svg>',
  );

// Extremos do degradê verde, iguais aos do Anotô original.
const COR_ESCURA = [0x10, 0x5f, 0x4b];
const COR_CLARA = [0xa8, 0xef, 0xdd];

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

/** Interpola o degradê verde conforme a quantidade de grupos. */
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
      const corpo = md.render(n.conteudo ?? "");
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
