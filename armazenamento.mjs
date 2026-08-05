/**
 * armazenamento.mjs — onde usuários, sessões e o log de acesso ficam.
 *
 * Duas implementações atrás da mesma interface:
 *
 *   - Supabase, quando SUPABASE_URL e SUPABASE_SERVICE_KEY existem;
 *   - arquivo local, caso contrário.
 *
 * O arquivo local não é gambiarra de desenvolvimento: é o que torna o login
 * testável sem depender de um projeto Supabase existir. A alternativa seria
 * escrever o fluxo às cegas e descobrir os erros só em produção.
 *
 * Fala com o Supabase por PostgREST via `fetch`, sem SDK — mesmo padrão do
 * ia.mjs com o Gemini. Uma dependência a menos para manter.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const AQUI = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------- arquivo local

function armazenamentoLocal(caminho) {
  const vazio = { usuarios: [], sessoes: [], acessos: [], teias: [], criterios: [] };

  const le = () => {
    if (!existsSync(caminho)) return structuredClone(vazio);
    try {
      return { ...structuredClone(vazio), ...JSON.parse(readFileSync(caminho, "utf8")) };
    } catch {
      return structuredClone(vazio);
    }
  };
  const grava = (d) => {
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, JSON.stringify(d, null, 2), "utf8");
  };

  return {
    tipo: "local",

    async achaUsuarioPorEmail(email) {
      return le().usuarios.find((u) => u.email === email) ?? null;
    },

    async criaUsuario({ email, telefone, senha_hash }) {
      const d = le();
      if (d.usuarios.some((u) => u.email === email)) {
        const e = new Error("e-mail já cadastrado");
        e.duplicado = true;
        throw e;
      }
      const u = { id: randomUUID(), email, telefone, senha_hash, criado_em: new Date().toISOString() };
      d.usuarios.push(u);
      grava(d);
      return u;
    },

    async criaSessao({ token, usuario_id, expira_em }) {
      const d = le();
      d.sessoes.push({ token, usuario_id, expira_em, criada_em: new Date().toISOString() });
      grava(d);
    },

    async achaSessao(token) {
      const d = le();
      const s = d.sessoes.find((x) => x.token === token);
      if (!s) return null;
      if (new Date(s.expira_em) < new Date()) return null;
      const u = d.usuarios.find((x) => x.id === s.usuario_id);
      return u ? { ...s, usuario: u } : null;
    },

    async apagaSessao(token) {
      const d = le();
      d.sessoes = d.sessoes.filter((s) => s.token !== token);
      grava(d);
    },

    async registraAcesso(acesso) {
      const d = le();
      d.acessos.push({ id: randomUUID(), quando: new Date().toISOString(), ...acesso });
      grava(d);
    },

    async atualizaAcesso(id, campos) {
      const d = le();
      const a = d.acessos.find((x) => x.job_id === id);
      if (a) Object.assign(a, campos);
      grava(d);
    },

    async listaAcessos({ limite = 200 } = {}) {
      const d = le();
      const porId = Object.fromEntries(d.usuarios.map((u) => [u.id, u.email]));
      return d.acessos
        .slice(-limite)
        .reverse()
        .map((a) => ({ ...a, email: porId[a.usuario_id] ?? "?" }));
    },

    // ------------------------------------------------------------ teias

    async criaTeia({ usuario_id, nome, objetivo, foco, mapa }) {
      const d = le();
      const agora = new Date().toISOString();
      const t = {
        id: randomUUID(), usuario_id, nome, objetivo: objetivo ?? null,
        foco: foco ?? null, mapa, n_notas: mapa?.notas?.length ?? 0,
        criada_em: agora, atualizada_em: agora,
      };
      d.teias.push(t);
      grava(d);
      return t;
    },

    /** Sem o `mapa`, para espelhar o que o Supabase devolve. */
    async listaTeias(usuario_id) {
      return le()
        .teias.filter((t) => t.usuario_id === usuario_id)
        .sort((a, b) => b.atualizada_em.localeCompare(a.atualizada_em))
        .map(({ mapa, ...resto }) => ({ ...resto, fontes: mapa?.fontes ?? [] }));
    },

    /**
     * Sempre pelo par (id, dono).
     *
     * Filtrar o dono aqui, e não em quem chama, é o que impede que uma rota
     * futura esqueça a checagem e vaze a teia de outro. A regra fica num lugar
     * só, e é este.
     */
    async achaTeia(id, usuario_id) {
      return le().teias.find((t) => t.id === id && t.usuario_id === usuario_id) ?? null;
    },

    async atualizaTeia(id, usuario_id, campos) {
      const d = le();
      const t = d.teias.find((x) => x.id === id && x.usuario_id === usuario_id);
      if (!t) return null;
      Object.assign(t, campos, { atualizada_em: new Date().toISOString() });
      // A contagem acompanha o mapa sozinha: deixá-la a cargo de quem chama
      // faria "51 notas" na lista descolar da teia em algum ponto.
      if (campos.mapa) t.n_notas = campos.mapa.notas?.length ?? 0;
      grava(d);
      return t;
    },

    async apagaTeia(id, usuario_id) {
      const d = le();
      const antes = d.teias.length;
      d.teias = d.teias.filter((t) => !(t.id === id && t.usuario_id === usuario_id));
      grava(d);
      return d.teias.length < antes;
    },

    // -------------------------------------------------------- critérios

    async achaCriterios(objetivo) {
      return le().criterios.find((c) => c.objetivo === objetivo) ?? null;
    },

    async gravaCriterios(objetivo, criterios) {
      const d = le();
      const existente = d.criterios.find((c) => c.objetivo === objetivo);
      const quando = new Date().toISOString();
      if (existente) Object.assign(existente, { criterios, quando });
      else d.criterios.push({ objetivo, criterios, quando });
      grava(d);
    },
  };
}

// ------------------------------------------------------------------ supabase

function armazenamentoSupabase(url, chave) {
  const base = `${url.replace(/\/$/, "")}/rest/v1`;
  const cabecalhos = {
    apikey: chave,
    Authorization: `Bearer ${chave}`,
    "Content-Type": "application/json",
  };

  /**
   * Erros do PostgREST sobem com o corpo junto. Numa primeira integração é a
   * mensagem do servidor ("relation does not exist") que diz o que fazer;
   * engolir isso transformaria um erro específico num "deu erro" inútil.
   */
  const chama = async (caminho, opcoes = {}) => {
    const r = await fetch(`${base}${caminho}`, {
      ...opcoes,
      headers: { ...cabecalhos, ...(opcoes.headers ?? {}) },
    });
    const texto = await r.text();
    if (!r.ok) {
      const e = new Error(`Supabase HTTP ${r.status}: ${texto.slice(0, 400)}`);
      // 23505 = violação de unicidade; é o e-mail repetido, não uma falha real.
      if (texto.includes("23505")) e.duplicado = true;
      throw e;
    }
    return texto ? JSON.parse(texto) : null;
  };

  const um = (linhas) => (Array.isArray(linhas) ? (linhas[0] ?? null) : linhas);

  return {
    tipo: "supabase",

    async achaUsuarioPorEmail(email) {
      return um(await chama(`/usuarios?email=eq.${encodeURIComponent(email)}&limit=1`));
    },

    async criaUsuario({ email, telefone, senha_hash }) {
      return um(
        await chama("/usuarios", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ email, telefone, senha_hash }),
        }),
      );
    },

    async criaSessao({ token, usuario_id, expira_em }) {
      await chama("/sessoes", {
        method: "POST",
        body: JSON.stringify({ token, usuario_id, expira_em }),
      });
    },

    async achaSessao(token) {
      const agora = new Date().toISOString();
      const linhas = await chama(
        `/sessoes?token=eq.${encodeURIComponent(token)}&expira_em=gt.${agora}` +
          "&select=token,expira_em,usuario_id,usuario:usuarios(id,email,telefone)&limit=1",
      );
      return um(linhas);
    },

    async apagaSessao(token) {
      await chama(`/sessoes?token=eq.${encodeURIComponent(token)}`, { method: "DELETE" });
    },

    async registraAcesso(acesso) {
      await chama("/acessos", { method: "POST", body: JSON.stringify(acesso) });
    },

    async atualizaAcesso(jobId, campos) {
      await chama(`/acessos?job_id=eq.${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        body: JSON.stringify(campos),
      });
    },

    async listaAcessos({ limite = 200 } = {}) {
      return (
        (await chama(
          `/acessos?select=*,usuario:usuarios(email)&order=quando.desc&limit=${limite}`,
        )) ?? []
      );
    },

    // ------------------------------------------------------------ teias

    async criaTeia({ usuario_id, nome, objetivo, foco, mapa }) {
      return um(
        await chama("/teias", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            usuario_id, nome, objetivo, foco, mapa,
            n_notas: mapa?.notas?.length ?? 0,
          }),
        }),
      );
    },

    /**
     * A lista NÃO traz o `mapa`.
     *
     * São 146 KB por teia; dez teias seriam 1,5 MB de JSON só para desenhar
     * uma lista de nomes. O que a lista precisa mostrar vem barato: `n_notas`
     * é coluna própria e `mapa->fontes` é um pedaço pequeno do jsonb, extraído
     * pelo Postgres sem trazer o resto. O mapa inteiro só em `achaTeia`.
     */
    async listaTeias(usuario_id) {
      return (
        (await chama(
          `/teias?usuario_id=eq.${encodeURIComponent(usuario_id)}` +
            "&select=id,nome,objetivo,foco,n_notas,criada_em,atualizada_em,fontes:mapa->fontes" +
            "&order=atualizada_em.desc",
        )) ?? []
      );
    },

    /**
     * Sempre pelo par (id, dono).
     *
     * O dono entra no próprio filtro, e não numa comparação depois da leitura:
     * uma rota futura que esqueça a checagem continua não achando a teia dos
     * outros, porque o banco nunca a devolveu.
     */
    async achaTeia(id, usuario_id) {
      return um(
        await chama(
          `/teias?id=eq.${encodeURIComponent(id)}` +
            `&usuario_id=eq.${encodeURIComponent(usuario_id)}&limit=1`,
        ),
      );
    },

    async atualizaTeia(id, usuario_id, campos) {
      return um(
        await chama(
          `/teias?id=eq.${encodeURIComponent(id)}&usuario_id=eq.${encodeURIComponent(usuario_id)}`,
          {
            method: "PATCH",
            headers: { Prefer: "return=representation" },
            body: JSON.stringify({
              ...campos,
              // A contagem acompanha o mapa sozinha — ver a versão local.
              ...(campos.mapa ? { n_notas: campos.mapa.notas?.length ?? 0 } : {}),
              atualizada_em: new Date().toISOString(),
            }),
          },
        ),
      );
    },

    async apagaTeia(id, usuario_id) {
      const r = await chama(
        `/teias?id=eq.${encodeURIComponent(id)}&usuario_id=eq.${encodeURIComponent(usuario_id)}`,
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      );
      return Array.isArray(r) ? r.length > 0 : Boolean(r);
    },

    // -------------------------------------------------------- critérios

    async achaCriterios(objetivo) {
      return um(await chama(`/criterios?objetivo=eq.${encodeURIComponent(objetivo)}&limit=1`));
    },

    async gravaCriterios(objetivo, criterios) {
      // upsert: o mesmo objetivo pesquisado de novo sobrescreve o que havia,
      // em vez de estourar a chave primária.
      await chama("/criterios", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ objetivo, criterios, quando: new Date().toISOString() }),
      });
    },
  };
}

// ------------------------------------------------------------------ escolha

export function abreArmazenamento(env = process.env) {
  const url = env.SUPABASE_URL;
  const chave = env.SUPABASE_SERVICE_KEY;
  if (url && chave) return armazenamentoSupabase(url, chave);
  return armazenamentoLocal(env.ARQUIVO_DADOS ?? join(AQUI, "trabalho", "dados.json"));
}
