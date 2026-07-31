/**
 * servidor.mjs — Weave como aplicação web.
 *
 * Desenho em duas partes por causa do tempo: uma rodada leva de 5 a 20
 * minutos, e nenhuma requisição HTTP sobrevive a isso sem cair em algum
 * proxy do caminho. Então o envio só ENFILEIRA o trabalho e devolve um id;
 * a tela pergunta o andamento de tempos em tempos e baixa quando fica pronto.
 *
 *   POST /api/jobs        → enfileira (corpo = bytes do PDF) → { id }
 *   GET  /api/jobs/:id    → { estado, progresso[], erro? }
 *   GET  /api/jobs/:id/html → o arquivo pronto
 *
 * Um job por vez, de propósito: o saldo do Gemini é pré-pago e dividido com
 * o Anotô em produção. Dois envios simultâneos dobrariam a queima sem avisar
 * ninguém.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfParaNotas, comRelator } from "./ia.mjs";
import { render } from "./render.mjs";

const AQUI = dirname(fileURLToPath(import.meta.url));
const TRABALHO = join(AQUI, "trabalho");
mkdirSync(TRABALHO, { recursive: true });

const app = express();
const PORTA = process.env.PORT || 3000;
const SENHA = process.env.SENHA_ACESSO || "";
const TETO_MB = Number(process.env.TETO_MB ?? 18);

// ------------------------------------------------------------------ estado

/**
 * Jobs vivem em memória; os arquivos, em disco.
 *
 * O disco do Render é efêmero — reinício ou deploy apaga tudo. Para uso
 * pessoal isso é aceitável (baixa-se o HTML na hora), mas significa que o
 * link de download não é um lugar permanente para guardar nada.
 */
const jobs = new Map();
const fila = [];
let rodando = false;

const criaJob = (nome, objetivo) => {
  const id = randomUUID().slice(0, 8);
  jobs.set(id, {
    id, nome, objetivo,
    estado: "na fila",
    progresso: [],
    criadoEm: Date.now(),
    erro: null,
  });
  return id;
};

function proximo() {
  if (rodando || !fila.length) return;
  rodando = true;
  const id = fila.shift();
  processa(id).finally(() => {
    rodando = false;
    proximo();
  });
}

async function processa(id) {
  const job = jobs.get(id);
  if (!job) return;

  job.estado = "processando";
  const anota = (...partes) => {
    const linha = partes
      .join(" ")
      .replace(/^[·!]\s*/, "")
      // O caminho interno do arquivo temporário não diz nada a quem espera —
      // mostra o nome que a pessoa enviou.
      .replace(/lendo \S+/, `lendo ${job.nome}`)
      .trim();
    if (linha) job.progresso.push(linha);
  };

  const pdf = join(TRABALHO, `${id}.pdf`);
  const html = join(TRABALHO, `${id}.html`);

  try {
    const dados = await comRelator(anota, () =>
      pdfParaNotas(pdf, {
        objetivo: job.objetivo,
        checkpoint: join(TRABALHO, `${id}.checkpoint.json`),
      }),
    );
    writeFileSync(html, render(dados), "utf8");
    job.notas = dados.notas.length;
    job.grupos = dados.grupos.length;
    job.titulo = dados.titulo;
    job.estado = "pronto";
  } catch (e) {
    job.estado = "erro";
    job.erro = e.message;
  } finally {
    // O PDF não precisa sobreviver ao processamento.
    try { if (existsSync(pdf)) unlinkSync(pdf); } catch { /* segue */ }
  }
}

// -------------------------------------------------------------------- auth

/**
 * Senha única compartilhada.
 *
 * Não é sofisticado, e o alvo não é sofisticado: impedir que a URL vazada num
 * encaminhamento de WhatsApp vire uma torneira aberta no saldo pré-pago.
 * Sem SENHA_ACESSO definida o servidor se recusa a subir — um app sem senha
 * exposto na internet gastaria dinheiro de verdade de quem o achasse.
 */
if (!SENHA) {
  console.error(
    "ERRO: defina SENHA_ACESSO antes de subir.\n" +
      "  Sem senha, qualquer um que ache a URL gasta o seu saldo do Gemini.",
  );
  process.exit(1);
}

const autoriza = (req, res, next) => {
  const enviada = req.get("x-senha") || req.query.senha || "";
  if (enviada === SENHA) return next();
  res.status(401).json({ erro: "senha incorreta" });
};

// ------------------------------------------------------------------- rotas

app.use(express.static(join(AQUI, "web")));

app.post(
  "/api/jobs",
  autoriza,
  express.raw({ type: "application/pdf", limit: `${TETO_MB}mb` }),
  (req, res) => {
    if (!req.body?.length) {
      return res.status(400).json({ erro: "corpo vazio — envie o PDF como application/pdf" });
    }
    if (req.body.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return res.status(400).json({ erro: "o arquivo não parece um PDF" });
    }

    const objetivo = (req.query.objetivo || "").toString().slice(0, 500);
    const nome = (req.query.nome || "documento.pdf").toString().slice(0, 120);

    const id = criaJob(nome, objetivo);
    writeFileSync(join(TRABALHO, `${id}.pdf`), req.body);

    fila.push(id);
    const posicao = fila.length;
    proximo();

    res.status(202).json({ id, posicaoNaFila: rodando ? posicao : 0 });
  },
);

app.get("/api/jobs/:id", autoriza, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ erro: "job não encontrado" });
  res.json({
    id: job.id,
    estado: job.estado,
    progresso: job.progresso,
    erro: job.erro,
    titulo: job.titulo,
    notas: job.notas,
    grupos: job.grupos,
    segundos: Math.round((Date.now() - job.criadoEm) / 1000),
  });
});

app.get("/api/jobs/:id/html", autoriza, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("job não encontrado");
  if (job.estado !== "pronto") return res.status(409).send(`job está em: ${job.estado}`);

  const arquivo = join(TRABALHO, `${job.id}.html`);
  if (!existsSync(arquivo)) return res.status(410).send("arquivo expirou (o servidor reiniciou)");

  const limpo = (job.titulo || job.nome).replace(/[^\p{L}\p{N} .-]/gu, "").trim() || "mapa";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${limpo}.html"`);
  res.send(readFileSync(arquivo));
});

// Erro do express.raw (arquivo acima do limite) chega aqui.
app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ erro: `PDF acima do limite de ${TETO_MB} MB` });
  }
  res.status(500).json({ erro: err?.message || "erro interno" });
});

app.listen(PORTA, () => {
  console.log(`Weave ouvindo na porta ${PORTA}`);
  console.log(`senha de acesso: ${SENHA.length} caracteres (definida por SENHA_ACESSO)`);
});
