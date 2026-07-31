/**
 * env.mjs — carrega o .env para dentro do process.env.
 *
 * Existe porque havia três leitores de .env no projeto (ia.mjs, checar.mjs e
 * o armazenamento, cada um à sua maneira) e o servidor não tinha nenhum: ele
 * lia process.env direto, então `npm run checar` passava e `npm start` morria
 * dizendo que faltava CODIGO_CONVITE, com o valor ali no arquivo.
 *
 * Importar este módulo no topo do executável resolve para todo mundo abaixo,
 * porque a partir daí `process.env` já contém tudo.
 *
 * O ambiente sempre vence o arquivo: no Render as variáveis vêm do painel e
 * não existe .env, mas se um dia existir, o painel continua mandando.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));

export function carregaEnv(caminho = join(AQUI, ".env")) {
  let texto;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch {
    return process.env; // sem arquivo: só o ambiente, que é o caso do Render
  }

  for (const linha of texto.split("\n")) {
    const corte = linha.indexOf("=");
    if (corte < 0) continue;
    const chave = linha.slice(0, corte).trim();
    if (!chave || chave.startsWith("#")) continue;
    if (process.env[chave]) continue; // já veio do ambiente
    process.env[chave] = linha.slice(corte + 1).trim().replace(/^["']|["']$/g, "");
  }
  return process.env;
}
