/**
 * Testes de senha e sessão.
 *
 * Autenticação é o tipo de código onde o erro não aparece usando — o app
 * funciona igual com uma comparação insegura ou com o sal fixo. Por isso as
 * propriedades são verificadas aqui, e não só o caminho feliz.
 *
 *   npm run teste
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  geraHash, conferaSenha, geraToken, expiraEm,
  validaCadastro, normalizaEmail, normalizaTelefone,
} from "../auth.mjs";

test("a senha correta confere e a errada não", async () => {
  const hash = await geraHash("senhaboa123");
  assert.ok(await conferaSenha("senhaboa123", hash));
  assert.ok(!(await conferaSenha("senhaboa124", hash)));
  assert.ok(!(await conferaSenha("", hash)));
});

test("a mesma senha gera hashes diferentes", async () => {
  // Sem sal por senha, hashes iguais entregariam quem usa a mesma senha, e
  // um único rainbow table quebraria todas as contas de uma vez.
  const a = await geraHash("senhaboa123");
  const b = await geraHash("senhaboa123");
  assert.notEqual(a, b);
  assert.ok(await conferaSenha("senhaboa123", a));
  assert.ok(await conferaSenha("senhaboa123", b));
});

test("o hash guarda os parâmetros de custo", async () => {
  // Sem isso, subir o custo no futuro trancaria todo mundo para fora, porque
  // os hashes antigos não teriam como ser verificados.
  const hash = await geraHash("senhaboa123");
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
});

test("a senha em texto puro não aparece no hash", async () => {
  const hash = await geraHash("umaSenhaBemEspecifica123");
  assert.ok(!hash.includes("umaSenhaBemEspecifica123"));
});

test("hash corrompido ou de outro formato não derruba nem passa", async () => {
  for (const ruim of ["", "abc", "bcrypt$x$y", "scrypt$a$b$c$d", null, undefined]) {
    assert.equal(await conferaSenha("qualquer", ruim), false);
  }
});

test("senha curta é recusada na geração", async () => {
  await assert.rejects(() => geraHash("1234567"));
});

test("tokens de sessão não se repetem e têm entropia suficiente", () => {
  const vistos = new Set();
  for (let i = 0; i < 500; i++) vistos.add(geraToken());
  assert.equal(vistos.size, 500);
  // 32 bytes em base64url dão 43 caracteres.
  assert.ok(geraToken().length >= 43);
});

test("a expiração fica no futuro", () => {
  assert.ok(new Date(expiraEm(30)) > new Date());
  assert.ok(new Date(expiraEm(30)) > new Date(expiraEm(1)));
});

test("e-mail e telefone são normalizados", () => {
  assert.equal(normalizaEmail("  Gabriel@Teste.COM "), "gabriel@teste.com");
  // Mesma pessoa não pode virar dois cadastros por causa de parênteses.
  assert.equal(normalizaTelefone("(81) 99999-8888"), "81999998888");
  assert.equal(normalizaTelefone("81999998888"), "81999998888");
});

test("validação do cadastro pega os casos ruins", () => {
  assert.equal(validaCadastro({ email: "a@b.co", telefone: "8199999888", senha: "12345678" }).erros.length, 0);

  const semArroba = validaCadastro({ email: "invalido", telefone: "8199999888", senha: "12345678" });
  assert.ok(semArroba.erros.some((e) => e.includes("e-mail")));

  const telCurto = validaCadastro({ email: "a@b.co", telefone: "999", senha: "12345678" });
  assert.ok(telCurto.erros.some((e) => e.includes("telefone")));

  const senhaCurta = validaCadastro({ email: "a@b.co", telefone: "8199999888", senha: "123" });
  assert.ok(senhaCurta.erros.some((e) => e.includes("senha")));
});

test("acentuação equivalente na senha não tranca a conta", async () => {
  // "ç" pode chegar como um caractere só ou como c + cedilha, conforme o
  // teclado e o sistema. Sem normalizar, a pessoa digitaria a mesma senha e
  // seria recusada, sem entender por quê.
  const composto = "sença12345"; // c + cedilha combinante
  const precomposto = "sença12345"; // ç
  const hash = await geraHash(composto);
  assert.ok(await conferaSenha(precomposto, hash));
});
