/**
 * Extrai template.html a partir do Anotô.html.
 *
 * ⚠️ HISTÓRICO. Este script serviu uma vez, para tirar o esqueleto visual do
 * Anotô.html. Desde então o template.html RECEBEU A IDENTIDADE DO WEAVE —
 * paleta preto/dourado, fios curvos, realce em dourado, a marca da teia — e
 * nada disso existe no arquivo de origem.
 *
 * Rodar de novo apagaria tudo isso sem avisar. Por isso o script se recusa a
 * sobrescrever um template que já tem a identidade aplicada; use --forcar
 * apenas se souber que quer voltar ao esqueleto cru.
 *
 * O template.html é a fonte da verdade agora, não este script.
 *
 * Marcadores criados:
 *   {{TITULO}}        <title> da página
 *   {{SUBTITULO}}     texto pequeno da topbar ("31 notas · ...")
 *   {{LOGO_SRC}}      src das duas <img class="logo-img">
 *   {{SIDEBAR}}       conteúdo do <nav class="sidebar">
 *   {{SECOES}}        conteúdo do <main class="content">
 *   {{GRAPH_DATA}}    JSON de nodes/links
 *   {{GROUP_COLORS}}  JSON de cores por grupo
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Caminho do HTML de referência. Sobrescrevível, já que o arquivo original
// vive fora deste projeto e pode estar em outro lugar na sua máquina:
//   node ferramentas/extrai-template.mjs "C:\caminho\para\Anotô.html"
const ORIGEM =
  process.argv[2] ?? join(RAIZ, "..", "Obsidian V2", "Anotô.html");
const DESTINO = join(RAIZ, "template.html");

// Linhas (1-indexed) confirmadas por inspeção do arquivo original.
const LINHA_TITULO = 3;
const LINHA_SUB = 98;
const LINHA_SIDEBAR = 113;
const LINHA_MAIN_INI = 114;
const LINHA_MAIN_FIM = 1494;
const LINHA_GRAPH_DATA = 3540;

function falha(msg) {
  console.error(`ERRO: ${msg}`);
  process.exit(1);
}

/** Garante que a linha n contém `trecho` antes de mexer nela. */
function confere(linhas, n, trecho, nome) {
  const real = linhas[n - 1] ?? "";
  if (!real.includes(trecho)) {
    falha(
      `linha ${n} não parece ser "${nome}".\n` +
        `  esperado conter: ${JSON.stringify(trecho)}\n` +
        `  encontrado:      ${JSON.stringify(real.slice(0, 120))}`,
    );
  }
}

if (!existsSync(ORIGEM)) falha(`não achei o arquivo de origem: ${ORIGEM}`);

// Trava contra apagar a identidade sem querer. A alternativa seria só um
// comentário no topo, e comentário não impede ninguém de rodar o comando.
if (existsSync(DESTINO) && !process.argv.includes("--forcar")) {
  const atual = readFileSync(DESTINO, "utf8");
  if (atual.includes("--ouro:#c6a15b")) {
    falha(
      "o template.html atual já tem a identidade do Weave aplicada.\n" +
        "  Regenerar a partir do Anotô.html descartaria paleta, fios curvos,\n" +
        "  realce em dourado e a marca — nada disso existe no arquivo de origem.\n" +
        "  Se é mesmo isso que você quer, rode de novo com --forcar.",
    );
  }
}

const linhas = readFileSync(ORIGEM, "utf8").split("\n");

// Valida todas as âncoras antes de alterar qualquer coisa, para que um
// arquivo diferente do esperado falhe alto em vez de gerar lixo silencioso.
confere(linhas, LINHA_TITULO, "<title>", "a tag <title>");
confere(linhas, LINHA_SUB, 'class="sub"', "o subtítulo da topbar");
confere(linhas, LINHA_SIDEBAR, '<nav class="sidebar"', "a sidebar");
confere(linhas, LINHA_MAIN_INI, '<main class="content">', "a abertura do main");
confere(linhas, LINHA_MAIN_FIM, "</main>", "o fechamento do main");
confere(linhas, LINHA_GRAPH_DATA, "__GRAPH_DATA__", "o JSON do grafo");

const novas = [];
for (let i = 1; i <= linhas.length; i++) {
  if (i === LINHA_TITULO) {
    novas.push("<title>{{TITULO}}</title>");
  } else if (i === LINHA_SUB) {
    novas.push('  <span class="sub">{{SUBTITULO}}</span>');
  } else if (i === LINHA_SIDEBAR) {
    novas.push('  <nav class="sidebar" id="sidebar">{{SIDEBAR}}</nav>');
  } else if (i === LINHA_MAIN_INI) {
    novas.push('  <main class="content">{{SECOES}}</main>');
  } else if (i > LINHA_MAIN_INI && i <= LINHA_MAIN_FIM) {
    continue; // já absorvido pelo marcador {{SECOES}}
  } else if (i === LINHA_GRAPH_DATA) {
    novas.push(
      "<script>window.__GRAPH_DATA__={{GRAPH_DATA}};" +
        "window.__GROUP_COLORS__={{GROUP_COLORS}};</script>",
    );
  } else {
    novas.push(linhas[i - 1]);
  }
}

let html = novas.join("\n");

// Troca o base64 das duas logos por um marcador único.
let nLogos = 0;
html = html.replace(
  /(class="logo-img" src=")data:image\/png;base64,[A-Za-z0-9+/=]+(")/g,
  (_m, antes, depois) => {
    nLogos++;
    return `${antes}{{LOGO_SRC}}${depois}`;
  },
);
if (nLogos !== 2) falha(`esperava 2 logos para trocar, troquei ${nLogos}`);

// A topbar e o cabeçalho do grafo traziam o nome "Anotô" escrito no HTML.
// Sem esta troca a marca do outro projeto vazaria para todo arquivo gerado.
// Precisa rodar DEPOIS da troca das logos, porque casa com {{LOGO_SRC}}.
const antesMarca = html;
html = html
  .replace(
    '<b><img class="logo-img" src="{{LOGO_SRC}}" alt="Anotô"> Anotô</b>',
    '<b><img class="logo-img" src="{{LOGO_SRC}}" alt="{{TITULO}}"> {{TITULO}}</b>',
  )
  .replaceAll('alt="Anotô"', 'alt="{{TITULO}}"');
if (antesMarca === html) falha("não encontrei a marca 'Anotô' na topbar para trocar");

// Fora do bundle do mermaid (que ocupa a maior parte do arquivo) não pode
// sobrar nenhuma citação ao outro projeto.
const foraDoBundle = html
  .split("\n")
  .filter((l, i) => i < 1500 || i > 3400)
  .join("\n");
if (foraDoBundle.includes("Anotô"))
  falha("sobrou a marca 'Anotô' no corpo do template");

mkdirSync(dirname(DESTINO), { recursive: true });
writeFileSync(DESTINO, html, "utf8");

const kb = (p) => (statSync(p).size / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
console.log(`template gravado: ${DESTINO}`);
console.log(`  original: ${kb(ORIGEM)} KB`);
console.log(`  template: ${kb(DESTINO)} KB  (o grosso é o mermaid embutido)`);
console.log(`  logos trocadas: ${nLogos}`);

for (const marcador of [
  "{{TITULO}}",
  "{{SUBTITULO}}",
  "{{LOGO_SRC}}",
  "{{SIDEBAR}}",
  "{{SECOES}}",
  "{{GRAPH_DATA}}",
  "{{GROUP_COLORS}}",
]) {
  if (!html.includes(marcador)) falha(`marcador ${marcador} não ficou no template`);
}
console.log("  todos os marcadores presentes");
