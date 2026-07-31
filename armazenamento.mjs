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
  const vazio = { usuarios: [], sessoes: [], acessos: [] };

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
  };
}

// ------------------------------------------------------------------ escolha

export function abreArmazenamento(env = process.env) {
  const url = env.SUPABASE_URL;
  const chave = env.SUPABASE_SERVICE_KEY;
  if (url && chave) return armazenamentoSupabase(url, chave);
  return armazenamentoLocal(env.ARQUIVO_DADOS ?? join(AQUI, "trabalho", "dados.json"));
}
