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
import { valida, normalizaMapa, ehCruzamento } from "./mapa.mjs";

// Re-exportado porque o formato do mapa mora em mapa.mjs, mas quem chama o
// render é quem quer saber se o JSON presta. Poupa um import a mais em cada
// ponto de uso.
export { valida };

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
/** Monta nodes/links no formato que o grafo do template consome. */
function montaGrafo(dados) {
  const fontes = dados.fontes ?? [];

  /**
   * Um nó-âncora por FONTE, no lugar do "home" único que existia antes.
   *
   * A troca não é cosmética: cada nota fica presa à âncora de cada fonte que a
   * sustenta, então a física separa a teia em um lóbulo por arquivo — e a nota
   * sustentada por duas é puxada pelos dois lados e PARA NO MEIO sozinha. O
   * cruzamento passa a aparecer pela posição, antes mesmo de olhar a cor.
   *
   * Com uma fonte só, o resultado é o mesmo miolo denso de antes; muda só o
   * rótulo, que passa a ser o nome do arquivo em vez de "Home".
   *
   * `fontes` e `cruza` viajam por nó para o desenho distinguir de onde veio o
   * quê. Preenchimento continua sendo do grupo; a fonte aparece no contorno.
   * Sem essa separação seriam dois sistemas de cor brigando pelo mesmo pixel.
   */
  const ancora = (id) => `fonte:${id}`;
  const nodes = [
    ...fontes.map((f) => ({
      id: ancora(f.id),
      label: f.nome,
      group: dados.grupos[0],
      fonte: f.id,
      fontes: [f.id],
      ancora: true,
      cruza: false,
    })),
    ...dados.notas.map((n) => ({
      id: n.id,
      label: n.titulo,
      group: n.grupo,
      fontes: n.fontes ?? [],
      cruza: ehCruzamento(n),
    })),
  ];

  const links = [];
  const vistos = new Set();
  const adiciona = (a, b, tipo) => {
    if (a === b) return;
    // O grafo é não-direcionado: A-B e B-A são a mesma aresta.
    const chave = [a, b].sort().join(" ");
    if (vistos.has(chave)) return;
    vistos.add(chave);
    links.push({ source: a, target: b, tipo });
  };

  for (const nota of dados.notas) {
    for (const f of nota.fontes ?? []) adiciona(ancora(f), nota.id, "âncora");
  }

  // O tipo do fio é o que o desenho usa para destacar a travessia. Atravessa
  // quando as duas notas não compartilham NENHUMA fonte — ou seja, quando a
  // ligação só existe porque materiais diferentes falam da mesma coisa. Num
  // mapa real esses fios são raros (4 em 148 na primeira teia de duas fontes),
  // e é justamente a raridade que os torna a informação mais valiosa da tela.
  const porId = new Map(dados.notas.map((n) => [n.id, n]));
  for (const nota of dados.notas) {
    for (const alvo of nota.relacionado ?? []) {
      const outra = porId.get(alvo);
      const mesma = outra && (nota.fontes ?? []).some((f) => (outra.fontes ?? []).includes(f));
      adiciona(nota.id, alvo, mesma ? "dentro" : "atravessa");
    }
  }

  return {
    group_order: dados.grupos,
    fontes: fontes.map((f) => ({ id: f.id, nome: f.nome, tipo: f.tipo })),
    nodes,
    links,
  };
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

/**
 * O mermaid embutido são 3,3 dos 3,4 MB do template.
 *
 * Quando o mapa era só um arquivo para baixar, esse peso se pagava uma vez. Ver
 * a teia dentro do app muda a conta: seriam 3,3 MB a cada abertura. Por isso as
 * duas modalidades — `embutido` no que se exporta (precisa abrir offline) e
 * `externo` no que se vê no app, onde o navegador cacheia o arquivo.
 */
const MARCA_MERMAID = /<!--MERMAID-->[\s\S]*?<!--\/MERMAID-->/;

/** O bundle do mermaid isolado do template, para ser servido à parte. */
export function mermaidDoTemplate(template) {
  const tpl = template ?? readFileSync(join(AQUI, "template.html"), "utf8");
  const bloco = tpl.match(MARCA_MERMAID)?.[0] ?? "";
  return bloco.replace(/^<!--MERMAID-->\s*<script>/, "").replace(/<\/script>\s*<!--\/MERMAID-->$/, "");
}

export function render(dados, { template, mermaid = "embutido", mermaidSrc = "/mermaid.js" } = {}) {
  // Normaliza ANTES de validar: mapas gerados antes de as fontes existirem não
  // têm o campo, e reprovar aqui quebraria todo JSON já salvo em saida/.
  dados = normalizaMapa(dados);

  const erros = valida(dados);
  if (erros.length) {
    const e = new Error(`JSON inválido:\n  - ${erros.join("\n  - ")}`);
    e.erros = erros;
    throw e;
  }

  let tpl = template ?? readFileSync(join(AQUI, "template.html"), "utf8");
  if (mermaid === "externo") {
    tpl = tpl.replace(MARCA_MERMAID, `<script src="${mermaidSrc}"></script>`);
  }
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
