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
 * o app em produção. Dois envios simultâneos dobrariam a queima sem avisar
 * ninguém.
 */

import { carregaEnv } from "./env.mjs";
import express from "express";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { fontesParaNotas, tecerFonte, comRelator } from "./ia.mjs";
import { render, mermaidDoTemplate } from "./render.mjs";
import { normalizaMapa, valida, sha1, juntaMapa, proximoIdDeFonte } from "./mapa.mjs";
import { aceita, EXTENSOES_ACEITAS } from "./fontes.mjs";
import { abreArmazenamento } from "./armazenamento.mjs";
import {
  geraHash, conferaSenha, geraToken, expiraEm,
  validaCadastro, normalizaEmail,
} from "./auth.mjs";

// Primeira linha executada do arquivo. Em ESM os `import` são avaliados antes
// de qualquer instrução do corpo, então não adianta chamar isto "antes" dos
// imports — o que importa é vir antes de qualquer leitura de process.env, e
// todas elas estão daqui para baixo.
carregaEnv();

const AQUI = dirname(fileURLToPath(import.meta.url));
const TRABALHO = join(AQUI, "trabalho");
mkdirSync(TRABALHO, { recursive: true });

const app = express();
const PORTA = process.env.PORT || 3000;
const TETO_MB = Number(process.env.TETO_MB ?? 18);
const dados = abreArmazenamento();

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

const criaJob = ({ nome, nomeTeia, objetivo, foco, usuarioId }) => {
  const id = randomUUID().slice(0, 8);
  jobs.set(id, {
    id, nome, nomeTeia, objetivo, foco, usuarioId, arquivo: null,
    estado: "na fila",
    progresso: [],
    criadoEm: Date.now(),
    erro: null,
    // Preenchidos ao terminar. `mapa` fica em memória mesmo depois de salvo:
    // é o que permite baixar o resultado se o banco recusar a gravação, em vez
    // de jogar fora uma rodada já paga.
    mapa: null,
    teiaId: null,
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

  const arquivo = job.arquivo;
  const fonte = [{ caminho: arquivo, nome: job.nome }];
  const checkpoint = join(TRABALHO, `${id}.checkpoint.json`);

  try {
    // Chamado `mapa`, não `dados`: no escopo do módulo `dados` é o
    // armazenamento, e sombreá-lo aqui faria o log de acesso escrever no
    // objeto errado sem erro nenhum.
    const mapa = job.teiaId
      ? await tece(job, fonte, checkpoint, anota)
      : await cria(job, fonte, checkpoint, anota, arquivo);

    job.mapa = mapa;
    job.notas = mapa.notas.length;
    job.grupos = mapa.grupos.length;
    job.titulo = mapa.titulo;

    // A partir daqui a rodada já foi paga. Se o banco recusar, o estado diz
    // isso com todas as letras e o mapa continua baixável pelo job — perder
    // trabalho pago por causa de uma indisponibilidade seria o pior desfecho.
    try {
      const teia = job.teiaId
        ? await dados.atualizaTeia(job.teiaId, job.usuarioId, { mapa })
        : await dados.criaTeia({
            usuario_id: job.usuarioId,
            nome: job.nomeTeia || mapa.titulo,
            objetivo: job.objetivo,
            foco: job.foco,
            mapa,
          });
      if (!teia) throw new Error("a teia sumiu enquanto o trabalho rodava");
      job.teiaId = teia.id;
      job.estado = "pronto";
      anota(`teia salva: ${teia.nome}`);
    } catch (e) {
      job.estado = "nao salvo";
      job.erro =
        `o mapa ficou pronto mas o banco recusou a gravação: ${e.message}\n` +
        "Baixe o arquivo agora — ele ainda está aqui, mas não sobrevive a um reinício.";
      anota("! mapa pronto, gravação no banco falhou — baixe antes de fechar");
    }
  } catch (e) {
    job.estado = "erro";
    job.erro = e.message;
  } finally {
    // O gasto real só se conhece no fim; é ele que diz quem consumiu o quê do
    // saldo dividido com o outro app.
    const gasto = job.progresso.join(" ").match(/([\d.]+) tokens de entrada · ([\d.]+) de saída/);
    const num = (s) => Number(String(s).replace(/\./g, "")) || null;
    dados
      .atualizaAcesso(id, {
        estado: job.estado,
        notas: job.notas ?? null,
        erro: job.erro,
        tokens_entrada: gasto ? num(gasto[1]) : null,
        tokens_saida: gasto ? num(gasto[2]) : null,
      })
      .catch((e) => console.error(`log de acesso falhou: ${e.message}`));

    // O arquivo enviado não precisa sobreviver ao processamento.
    try { if (existsSync(arquivo)) unlinkSync(arquivo); } catch { /* segue */ }
  }
}

/** Teia nova: a fonte é a primeira, e o mapa nasce dela. */
async function cria(job, fonte, checkpoint, anota, arquivo) {
  const bruto = await comRelator(anota, () =>
    fontesParaNotas(fonte, { objetivo: job.objetivo, foco: job.foco, checkpoint }),
  );
  const mapa = normalizaMapa(bruto, {
    nome: job.nome,
    quando: new Date().toISOString(),
    hash: sha1(readFileSync(arquivo)),
  });
  const erros = valida(mapa);
  if (erros.length) throw new Error(`mapa inválido:\n  - ${erros.join("\n  - ")}`);
  return mapa;
}

/**
 * Teia existente: a fonte se soma ao que já está lá.
 *
 * A teia é relida do banco AGORA, e não no momento do envio: entre um e outro
 * pode ter havido outra tecelagem, e partir da versão velha apagaria o que ela
 * acrescentou.
 */
async function tece(job, fonte, checkpoint, anota) {
  const teia = await dados.achaTeia(job.teiaId, job.usuarioId);
  if (!teia) throw new Error("teia não encontrada");

  const atual = normalizaMapa(teia.mapa, { nome: teia.nome });
  const resultado = await comRelator(anota, () =>
    tecerFonte(atual, fonte, {
      objetivo: teia.objetivo ?? job.objetivo,
      foco: job.foco,
      checkpoint,
    }),
  );

  const { mapa, relatorio } = juntaMapa(atual, {
    fonte: { ...resultado.fonte, id: proximoIdDeFonte(atual.fontes) },
    notasNovas: resultado.notasNovas,
    gruposNovos: resultado.gruposNovos,
    reforcos: resultado.reforcos,
  });

  // Enriquecimento aplicado depois da junção, sobre o mapa já montado.
  const porId = new Map(mapa.notas.map((n) => [n.id, n]));
  let enriquecidas = 0;
  for (const [id, conteudo] of Object.entries(resultado.enriquecidos ?? {})) {
    const nota = porId.get(id);
    if (nota && conteudo?.trim()) { nota.conteudo = conteudo; enriquecidas++; }
  }

  anota(
    `${relatorio.novas} nota(s) nova(s) · ${relatorio.reforcadas} reforçada(s) · ` +
      `${enriquecidas} reescrita(s) · ${relatorio.ligacoes} ligação(ões) atravessando fontes`,
  );
  if (relatorio.descartadas) anota(`! ${relatorio.descartadas} ligação(ões) inválida(s) descartada(s)`);
  if (relatorio.ilhas.length) anota(`! ${relatorio.ilhas.length} nota(s) sem ligação com o mapa antigo`);

  // A validação roda DEPOIS da junção, não só na geração inicial. Juntar notas
  // novas às antigas é exatamente onde nasce ligação para id inexistente, e é
  // o defeito que some do gráfico sem dar erro nenhum.
  const erros = valida(mapa);
  if (erros.length) throw new Error(`a junção produziu um mapa inválido:\n  - ${erros.join("\n  - ")}`);
  return mapa;
}

// -------------------------------------------------------------------- auth

/**
 * Sessão por usuário, substituindo a senha única que existia antes.
 *
 * O token vem no cabeçalho ou num cookie httpOnly. O cookie existe por causa
 * do download: `<a href>` não carrega cabeçalho, e mandar o token na query
 * string o deixaria no histórico do navegador e no log de qualquer proxy.
 */
async function autoriza(req, res, next) {
  const token =
    req.get("x-sessao") ||
    (req.get("cookie") ?? "").match(/(?:^|;\s*)weave_sessao=([^;]+)/)?.[1] ||
    "";
  if (!token) return res.status(401).json({ erro: "não autenticado" });

  let sessao;
  try {
    sessao = await dados.achaSessao(token);
  } catch (e) {
    return res.status(503).json({ erro: `banco indisponível: ${e.message}` });
  }
  if (!sessao) return res.status(401).json({ erro: "sessão expirada ou inválida" });

  req.usuario = sessao.usuario;
  req.sessao = token;
  next();
}

const cookieDeSessao = (token, expira) =>
  `weave_sessao=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(expira).toUTCString()}` +
  // Secure só quando há HTTPS: em localhost o navegador descartaria o cookie.
  (process.env.NODE_ENV === "production" ? "; Secure" : "");

// ------------------------------------------------------------------- rotas

app.use(express.static(join(AQUI, "web")));
app.use(express.json({ limit: "16kb" }));

/**
 * Código de convite no cadastro.
 *
 * Sem ele, trocar a senha única por contas seria uma piora: antes a senha
 * barrava tudo; com cadastro livre, quem achasse a URL criaria conta e gastaria
 * o saldo pré-pago dividido com o outro app. O código faz o mesmo papel da senha
 * antiga — separar conhecidos de desconhecidos — só que uma vez por pessoa, em
 * vez de a cada acesso.
 */
const CONVITE = process.env.CODIGO_CONVITE || "";
if (!CONVITE) {
  console.error(
    "ERRO: defina CODIGO_CONVITE antes de subir.\n" +
      "  Sem ele, qualquer um que ache a URL cria conta e gasta o seu saldo do Gemini.",
  );
  process.exit(1);
}

app.post("/api/registrar", async (req, res) => {
  if ((req.body?.convite ?? "") !== CONVITE) {
    return res.status(403).json({ erro: "código de convite inválido" });
  }

  const { erros, email, telefone } = validaCadastro(req.body ?? {});
  if (erros.length) return res.status(400).json({ erro: erros.join("; ") });

  try {
    const senha_hash = await geraHash(req.body.senha);
    const usuario = await dados.criaUsuario({ email, telefone, senha_hash });
    const token = geraToken();
    const expira = expiraEm();
    await dados.criaSessao({ token, usuario_id: usuario.id, expira_em: expira });

    res.setHeader("Set-Cookie", cookieDeSessao(token, expira));
    res.status(201).json({ email: usuario.email, telefone: usuario.telefone });
  } catch (e) {
    if (e.duplicado) return res.status(409).json({ erro: "este e-mail já tem cadastro" });
    res.status(500).json({ erro: e.message });
  }
});

app.post("/api/entrar", async (req, res) => {
  const email = normalizaEmail(req.body?.email);
  const senha = req.body?.senha;

  const usuario = await dados.achaUsuarioPorEmail(email).catch(() => null);
  const ok = usuario ? await conferaSenha(senha, usuario.senha_hash) : false;

  // Mesma mensagem para e-mail inexistente e senha errada: dizer qual dos dois
  // falhou entregaria de graça a lista de quem tem cadastro.
  if (!ok) return res.status(401).json({ erro: "e-mail ou senha incorretos" });

  const token = geraToken();
  const expira = expiraEm();
  await dados.criaSessao({ token, usuario_id: usuario.id, expira_em: expira });

  res.setHeader("Set-Cookie", cookieDeSessao(token, expira));
  res.json({ email: usuario.email, telefone: usuario.telefone });
});

app.post("/api/sair", autoriza, async (req, res) => {
  await dados.apagaSessao(req.sessao);
  res.setHeader("Set-Cookie", "weave_sessao=; HttpOnly; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/eu", autoriza, (req, res) => {
  res.json({ email: req.usuario.email, telefone: req.usuario.telefone });
});

/**
 * Log de acesso.
 *
 * Cada pessoa vê o próprio histórico. O log completo — quem entrou, o que
 * mandou, quanto gastou — fica com quem estiver em ADMIN_EMAIL. Sem esse
 * recorte, um usuário leria o nome dos arquivos que os outros enviaram.
 */
const ADMIN = normalizaEmail(process.env.ADMIN_EMAIL ?? "");

app.get("/api/acessos", autoriza, async (req, res) => {
  const ehAdmin = ADMIN && req.usuario.email === ADMIN;
  try {
    const todos = await dados.listaAcessos({ limite: 200 });
    res.json(ehAdmin ? todos : todos.filter((a) => a.usuario_id === req.usuario.id));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// `type: () => true` porque o corpo agora pode ser planilha, DOCX ou texto,
// e nem todo navegador acerta o Content-Type de arquivo escolhido pelo
// usuário. Quem decide o formato é a extensão do nome, conferida no enfileira.
const corpoCru = express.raw({ type: () => true, limit: `${TETO_MB}mb` });

/**
 * Recebe o arquivo e põe na fila.
 *
 * Criar teia e tecer numa teia existente diferem em UMA coisa — se `teiaId`
 * vem preenchido. Todo o resto (validar formato, gravar o temporário, registrar
 * no log de acesso, enfileirar) é idêntico, e duplicar isso em duas rotas seria
 * garantir que uma correção futura entrasse só numa delas.
 */
function enfileira(req, res, teiaId = null) {
  if (!req.body?.length) return res.status(400).json({ erro: "corpo vazio" });

  const objetivo = (req.query.objetivo || "").toString().slice(0, 500);
  const foco = (req.query.foco || "").toString().slice(0, 500);
  const nome = (req.query.nome || "documento.pdf").toString().slice(0, 120);
  const nomeTeia = (req.query.teia || "").toString().trim().slice(0, 120);

  if (!aceita(nome)) {
    return res.status(400).json({
      erro: `não sei ler '${nome}'. Aceito: ${EXTENSOES_ACEITAS.join(", ")}`,
    });
  }

  const id = criaJob({ nome, nomeTeia, objetivo, foco, usuarioId: req.usuario.id });
  const job = jobs.get(id);
  job.teiaId = teiaId;
  // A extensão fica no arquivo temporário: é por ela que o fontes.mjs sabe
  // se converte ou manda como está.
  job.arquivo = join(TRABALHO, `${id}${extname(nome).toLowerCase()}`);
  writeFileSync(job.arquivo, req.body);

  // O log entra aqui, no envio, e não ao terminar: se o trabalho falhar ou o
  // servidor cair no meio, você ainda precisa saber que alguém mandou aquilo.
  dados
    .registraAcesso({
      usuario_id: req.usuario.id,
      job_id: id,
      arquivo: nome,
      tamanho_bytes: req.body.length,
      objetivo,
      estado: "na fila",
    })
    .catch((e) => console.error(`log de acesso falhou: ${e.message}`));

  fila.push(id);
  const posicao = fila.length;
  proximo();

  res.status(202).json({ id, posicaoNaFila: rodando ? posicao : 0 });
}

app.post("/api/jobs", autoriza, corpoCru, (req, res) => enfileira(req, res));

/**
 * Só o dono enxerga o próprio trabalho.
 *
 * Com a senha única isso não importava — todo mundo era a mesma pessoa. Agora
 * que há contas, um id de 8 caracteres seria suficiente para alguém ler ou
 * baixar o mapa de outro. Responde 404, e não 403, para não confirmar que o
 * id existe.
 */
const meuJob = (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.usuarioId !== req.usuario.id) return null;
  return job;
};

app.get("/api/jobs/:id", autoriza, (req, res) => {
  const job = meuJob(req, res);
  if (!job) return res.status(404).json({ erro: "job não encontrado" });
  res.json({
    id: job.id,
    estado: job.estado,
    progresso: job.progresso,
    erro: job.erro,
    titulo: job.titulo,
    notas: job.notas,
    grupos: job.grupos,
    teiaId: job.teiaId,
    segundos: Math.round((Date.now() - job.criadoEm) / 1000),
  });
});

/**
 * Resgate: baixar o mapa direto do job.
 *
 * Existe para o caso "pronto mas não salvo" — quando a rodada foi paga e o
 * banco recusou a gravação. Fora disso, quem baixa é /api/teias/:id/html.
 */
app.get("/api/jobs/:id/html", autoriza, (req, res) => {
  const job = meuJob(req, res);
  if (!job) return res.status(404).send("job não encontrado");
  if (!job.mapa) return res.status(409).send(`job está em: ${job.estado}`);
  enviaHtml(res, job.mapa, { baixar: true, nome: job.titulo || job.nome });
});

// --------------------------------------------------------------------- teias

/**
 * O HTML sai do JSON na hora, e não de um arquivo em disco.
 *
 * Renderizar custa 0,2 s e zero de cota, então guardar o resultado nunca
 * compensou o problema que criava: o disco do Render é apagado a cada deploy,
 * e o link de download morria junto ("arquivo expirou"). Com o mapa no banco,
 * esse erro deixa de existir.
 *
 * Duas modalidades de mermaid pelo mesmo motivo: embutido tem 3,3 MB e precisa
 * estar lá no arquivo que se leva embora; para ver aqui dentro, é servido à
 * parte e o navegador cacheia — 3,38 MB viram 207 KB por abertura.
 */
function enviaHtml(res, mapa, { baixar, nome }) {
  const html = render(mapa, { mermaid: baixar ? "embutido" : "externo" });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (baixar) {
    const limpo = String(nome ?? "mapa").replace(/[^\p{L}\p{N} .-]/gu, "").trim() || "mapa";
    res.setHeader("Content-Disposition", `attachment; filename="${limpo}.html"`);
  }
  res.send(html);
}

/** O bundle do mermaid, extraído do template uma vez e servido à parte. */
let MERMAID = null;
app.get("/mermaid.js", (_req, res) => {
  MERMAID ??= mermaidDoTemplate();
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  // Imutável: o conteúdo só muda quando o template muda, o que implica deploy.
  res.setHeader("Cache-Control", "public, max-age=604800, immutable");
  res.send(MERMAID);
});

app.get("/api/teias", autoriza, async (req, res) => {
  try {
    // `listaTeias` já vem sem o mapa e com o que a tela precisa. Nenhuma
    // consulta por teia: dez teias seriam dez idas ao banco e 1,5 MB de JSON
    // para desenhar dez linhas de texto.
    const lista = await dados.listaTeias(req.usuario.id);
    res.json(
      lista.map((t) => ({
        id: t.id,
        nome: t.nome,
        objetivo: t.objetivo,
        atualizada_em: t.atualizada_em,
        notas: t.n_notas ?? 0,
        fontes: (t.fontes ?? []).map((f) => ({ id: f.id, nome: f.nome, tipo: f.tipo })),
      })),
    );
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/**
 * Toda rota de teia passa por aqui.
 *
 * O dono já é filtro dentro de `achaTeia`, então uma teia de outra pessoa nem
 * chega a ser lida do banco. O 404 (e não 403) é para não confirmar que o id
 * existe — mesmo cuidado que `meuJob` já tinha.
 */
async function minhaTeia(req, res) {
  try {
    const teia = await dados.achaTeia(req.params.id, req.usuario.id);
    if (!teia) {
      res.status(404).json({ erro: "teia não encontrada" });
      return null;
    }
    return teia;
  } catch (e) {
    res.status(503).json({ erro: `banco indisponível: ${e.message}` });
    return null;
  }
}

app.get("/api/teias/:id", autoriza, async (req, res) => {
  const teia = await minhaTeia(req, res);
  if (teia) res.json(teia);
});

app.get("/api/teias/:id/html", autoriza, async (req, res) => {
  const teia = await minhaTeia(req, res);
  if (!teia) return;
  enviaHtml(res, normalizaMapa(teia.mapa, { nome: teia.nome }), {
    baixar: req.query.baixar === "1",
    nome: teia.nome,
  });
});

/**
 * O botão **+**: acrescenta uma fonte a uma teia que já existe.
 *
 * A checagem de dono é um middleware ANTES do `corpoCru`, e a ordem é o ponto:
 * `express.raw` bufferiza a requisição inteira na memória, então deixá-lo
 * primeiro faria o servidor guardar 18 MB para só depois descobrir que a teia
 * é de outra pessoa. Responde 404, e não 403, pelo mesmo motivo de sempre —
 * não confirmar que o id existe.
 */
app.post(
  "/api/teias/:id/tecer",
  autoriza,
  async (req, res, next) => {
    const teia = await minhaTeia(req, res);
    if (!teia) return; // minhaTeia já respondeu
    req.teiaId = teia.id;
    next();
  },
  corpoCru,
  (req, res) => enfileira(req, res, req.teiaId),
);

app.delete("/api/teias/:id", autoriza, async (req, res) => {
  try {
    const foi = await dados.apagaTeia(req.params.id, req.usuario.id);
    if (!foi) return res.status(404).json({ erro: "teia não encontrada" });
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
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
  console.log(`armazenamento: ${dados.tipo}`);
  if (dados.tipo === "local") {
    console.warn(
      "  ATENÇÃO: sem SUPABASE_URL/SUPABASE_SERVICE_KEY, os dados vão para um\n" +
        "  arquivo em trabalho/. No Render esse disco é apagado a cada deploy —\n" +
        "  usuários e log de acesso sumiriam junto. Serve para rodar aqui, não lá.",
    );
  }
  console.log(ADMIN ? `admin: ${ADMIN}` : "admin: nenhum (defina ADMIN_EMAIL para ver o log completo)");
});
