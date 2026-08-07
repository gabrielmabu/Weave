/**
 * Roda o JavaScript do gráfico de verdade, num DOM de mentira.
 *
 * Existe por causa de um bug que passou por TODAS as outras redes: uma edição
 * deixou `l.tipo === âncora` sem aspas. Isso é sintaxe válida — um
 * identificador — então `node --check` passou, os 64 testes passaram e o HTML
 * foi gerado sem reclamar. Só que a cada quadro da física aquilo lançava
 * ReferenceError, e o efeito na tela era traiçoeiro:
 *
 *   - primeiro clique: `tick()` estourava antes de `loop()` começar, tela preta;
 *   - segundo clique: alpha já era 0, a física era pulada, e o `draw()` desenhava
 *     os nós ONDE O initNodes OS COLOCOU — um círculo. Parecia uma "mandala";
 *   - tocar num nó reaquecia a simulação, ela estourava de novo, e o desenho
 *     congelava. Parecia que "as bolinhas não respondem".
 *
 * Nenhum desses sintomas aponta para a causa. Um teste que só verifica sintaxe
 * nunca o pegaria; este roda a física e exige que os nós de fato se movam.
 *
 *   npm run teste
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../render.mjs";
import { normalizaMapa } from "../mapa.mjs";

/** O mínimo de DOM para o script do gráfico rodar. */
function palcoFalso() {
  const erros = [];
  const nada = () => {};
  // As posições dos nós vivem dentro da IIFE do gráfico. O jeito de observá-las
  // de fora é gravar o que o draw() pinta: cada rótulo vai para o canvas com as
  // coordenadas de tela do nó.
  const rotulos = [];
  const ctx = new Proxy(
    {
      canvas: null,
      measureText: () => ({ width: 10 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      createLinearGradient: () => ({ addColorStop: nada }),
      fillText: (texto, x, y) => rotulos.push({ texto, x, y }),
    },
    { get: (alvo, k) => (k in alvo ? alvo[k] : nada), set: () => true },
  );

  const elemento = (id) => ({
    id,
    style: {},
    dataset: {},
    classList: {
      _: new Set(),
      add(c) { this._.add(c); },
      remove(c) { this._.delete(c); },
      contains(c) { return this._.has(c); },
      toggle(c, f) { const v = f ?? !this._.has(c); v ? this._.add(c) : this._.delete(c); return v; },
    },
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }),
    addEventListener: nada,
    appendChild: nada,
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html ?? ""; },
    textContent: "",
    width: 0, height: 0,
  });

  const elementos = new Map();
  const doc = {
    getElementById: (id) => {
      if (!elementos.has(id)) elementos.set(id, elemento(id));
      return elementos.get(id);
    },
    querySelectorAll: () => [],
    body: { style: {} },
    addEventListener: nada,
  };

  const win = {
    document: doc,
    devicePixelRatio: 1,
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: nada,
    // O loop de animação NÃO roda: quem chama decide quando avançar a física,
    // senão o teste dependeria de tempo real.
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: nada,
    location: { hash: "" },
    setTimeout: nada,
    Math, JSON, console, Set, Map, Object, Array, Number, String, Boolean, Date,
  };
  win.window = win;
  return { win, doc, erros, elementos, rotulos };
}

/** Extrai o script do gráfico do HTML gerado e o executa no palco falso. */
function rodaGrafo(html) {
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const script = blocos.find((b) => b.includes("__GRAPH_DATA__") && b.includes("function tick"));
  assert.ok(script, "não achei o script do gráfico no HTML gerado");

  const dadosScript = blocos.find((b) => b.startsWith("window.__GRAPH_DATA__="));
  const { win, rotulos } = palcoFalso();

  const executa = new Function(
    "window", "document", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio",
    `${dadosScript}\n${script}\nreturn window.__openGraph;`,
  );
  const abre = executa(win, win.document, win.requestAnimationFrame, win.cancelAnimationFrame, 1);
  return { abre, win, rotulos };
}

const mapaDeTeste = () =>
  normalizaMapa({
    titulo: "Teste",
    grupos: ["01 - Um", "02 - Dois"],
    fontes: [
      { id: "f1", nome: "apostila.pdf", tipo: "pdf" },
      { id: "f2", nome: "aula.txt", tipo: "txt" },
    ],
    notas: [
      { id: "a", titulo: "A", grupo: "01 - Um", resumo: "", conteudo: "x", relacionado: ["b"], fontes: ["f1"] },
      // b→d é o fio que ATRAVESSA: b só tem f1, d só tem f2, então essa ligação
      // só existe porque materiais diferentes falam da mesma coisa.
      { id: "b", titulo: "B", grupo: "01 - Um", resumo: "", conteudo: "x", relacionado: ["a", "c", "d"], fontes: ["f1"] },
      { id: "c", titulo: "C", grupo: "02 - Dois", resumo: "", conteudo: "x", relacionado: ["b"], fontes: ["f1", "f2"] },
      { id: "d", titulo: "D", grupo: "02 - Dois", resumo: "", conteudo: "x", relacionado: ["c"], fontes: ["f2"] },
    ],
  });

test("a física do gráfico roda sem estourar e move os nós", () => {
  const { abre, win } = rodaGrafo(render(mapaDeTeste()));
  assert.equal(typeof abre, "function", "openGraph não foi exposto");

  // openGraph faz 250 + 220 passos de física antes de desenhar. Se qualquer um
  // deles lançar — foi o que aconteceu com o `âncora` sem aspas — isto explode
  // aqui, e não em silêncio na tela de quem estiver usando.
  assert.doesNotThrow(() => abre(), "a abertura do gráfico lançou exceção");

  const canvas = win.document.getElementById("graphCanvas");
  assert.ok(canvas.width > 0, "o canvas não foi dimensionado");
});

test("as âncoras de fonte param em hemisférios opostos", () => {
  // Duas fontes precisam virar duas teias que se tocam, não uma mandala com um
  // miolo só. Sem uma força própria, cada âncora é puxada pelas dezenas de
  // notas dela, o saldo aponta para o centro do grafo, e as duas empilham no
  // mesmo ponto — foi exatamente o que apareceu no primeiro teste real.
  const { abre, rotulos } = rodaGrafo(render(mapaDeTeste()));
  abre();

  const acha = (nome) => rotulos.find((r) => r.texto === nome);
  const esquerda = acha("apostila.pdf");
  const direita = acha("aula.txt");
  assert.ok(esquerda && direita, "as duas âncoras precisam ser rotuladas na tela");

  const distancia = Math.abs(esquerda.x - direita.x);
  assert.ok(
    distancia > 200,
    `as âncoras ficaram a ${distancia.toFixed(0)}px na horizontal — empilharam de novo`,
  );

  // E na ordem declarada: a primeira fonte à esquerda, a segunda à direita.
  assert.ok(esquerda.x < direita.x, "a ordem dos hemisférios inverteu");
});

test("cada nota assenta do lado da fonte dela", () => {
  const { abre, rotulos } = rodaGrafo(render(mapaDeTeste()));
  abre();

  const x = (nome) => rotulos.find((r) => r.texto === nome)?.x;
  const meio = (x("apostila.pdf") + x("aula.txt")) / 2;

  // 'A' e 'B' só existem na apostila; 'D' só na aula.
  assert.ok(x("A") < meio, "A deveria estar do lado da apostila");
  assert.ok(x("B") < meio, "B deveria estar do lado da apostila");
  assert.ok(x("D") > meio, "D deveria estar do lado da aula");
});

test("o grafo declara os três tipos de fio", () => {
  const html = render(mapaDeTeste());
  const g = JSON.parse(html.match(/window\.__GRAPH_DATA__=(\{.*?\});window\.__GROUP/)[1]);
  const tipos = new Set(g.links.map((l) => l.tipo));

  // 'âncora' com acento: é o valor que já foi escrito sem aspas por engano.
  assert.ok(tipos.has("âncora"), "faltou o fio de âncora");
  assert.ok(tipos.has("dentro"), "faltou o fio dentro da mesma fonte");
  assert.ok(tipos.has("atravessa"), "faltou o fio que atravessa fontes");

  // A nota 'c' tem duas fontes: 'd'→'c' atravessa, porque d só tem f2 e a
  // ligação só existe porque materiais diferentes falam da mesma coisa.
  const atravessa = g.links.filter((l) => l.tipo === "atravessa");
  assert.equal(atravessa.length, 1);
});

test("nenhum nó 'home' sobrou depois da troca por âncoras", () => {
  const html = render(mapaDeTeste());
  const g = JSON.parse(html.match(/window\.__GRAPH_DATA__=(\{.*?\});window\.__GROUP/)[1]);
  assert.ok(!g.nodes.some((n) => n.id === "home"));
  assert.equal(g.nodes.filter((n) => n.ancora).length, 2);
});
