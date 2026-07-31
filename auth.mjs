/**
 * auth.mjs — senhas e sessões.
 *
 * Escrito à mão de propósito, e vale dizer por quê: o Supabase tem Auth
 * pronto, mas usá-lo tornaria impossível rodar e testar o login sem um projeto
 * Supabase existindo. Aqui o Supabase é só o banco, e a autenticação é código
 * nosso — testável, e com uma superfície pequena o suficiente para caber na
 * cabeça: derivar hash, comparar, emitir sessão.
 *
 * Se um dia o app abrir para desconhecidos, migrar para o Supabase Auth passa
 * a valer a pena: confirmação de e-mail e recuperação de senha são trabalhosas
 * de fazer bem, e lá já vêm prontas.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// Parâmetros de custo do scrypt. N=2^15 leva ~100ms numa máquina comum: rápido
// o bastante para um login, lento o bastante para tornar força bruta cara.
const CUSTO = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TAMANHO_HASH = 32;

export const DIAS_DE_SESSAO = 30;

/** Deriva o hash de uma senha, com sal novo a cada chamada. */
export async function geraHash(senha) {
  if (typeof senha !== "string" || senha.length < 8) {
    throw new Error("a senha precisa de pelo menos 8 caracteres");
  }
  const sal = randomBytes(16);
  const derivado = await scrypt(senha.normalize("NFKC"), sal, TAMANHO_HASH, CUSTO);
  // Guarda os parâmetros junto: se o custo mudar no futuro, hashes antigos
  // continuam verificáveis em vez de virarem lixo que tranca todo mundo fora.
  return `scrypt$${CUSTO.N}$${CUSTO.r}$${CUSTO.p}$${sal.toString("base64")}$${derivado.toString("base64")}`;
}

/** Confere uma senha contra o hash guardado. */
export async function conferaSenha(senha, guardado) {
  if (typeof senha !== "string" || typeof guardado !== "string") return false;
  const partes = guardado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;

  const [, N, r, p, salB64, hashB64] = partes;
  const sal = Buffer.from(salB64, "base64");
  const esperado = Buffer.from(hashB64, "base64");

  let derivado;
  try {
    derivado = await scrypt(senha.normalize("NFKC"), sal, esperado.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: CUSTO.maxmem,
    });
  } catch {
    return false;
  }

  // Comparação de tempo constante: `===` vazaria, pelo tempo de resposta,
  // quantos bytes iniciais estavam certos.
  return derivado.length === esperado.length && timingSafeEqual(derivado, esperado);
}

/** Token de sessão: 256 bits de aleatoriedade criptográfica. */
export function geraToken() {
  return randomBytes(32).toString("base64url");
}

export function expiraEm(dias = DIAS_DE_SESSAO) {
  return new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
}

// --------------------------------------------------------------- validação

export function normalizaEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Guarda apenas os dígitos do telefone.
 *
 * Normalizar na entrada evita o mesmo número cadastrado duas vezes por causa
 * de parênteses e traço — "(81) 99999-8888" e "81999998888" são a mesma pessoa.
 */
export function normalizaTelefone(tel) {
  return String(tel ?? "").replace(/\D/g, "");
}

export function validaCadastro({ email, telefone, senha }) {
  const erros = [];
  const e = normalizaEmail(email);
  const t = normalizaTelefone(telefone);

  // Validação de e-mail deliberadamente frouxa: a regra completa da RFC rejeita
  // endereços válidos e aceita inválidos. Quem confirma de verdade é o envio.
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) erros.push("e-mail inválido");
  if (t.length < 10 || t.length > 13) erros.push("telefone deve ter DDD e número");
  if (typeof senha !== "string" || senha.length < 8) {
    erros.push("a senha precisa de pelo menos 8 caracteres");
  }
  return { erros, email: e, telefone: t };
}
