/**
 * Põe um mapa já pronto na conta de alguém, sem gastar cota.
 *
 *   node ferramentas/semear.mjs saida/dpc2.json --email voce@exemplo.com
 *   node ferramentas/semear.mjs saida/dpc2.json --email voce@exemplo.com --nome "Processual Civil"
 *
 * Existe por um motivo concreto: as rodadas feitas antes de "Minhas Teias"
 * existir foram pagas, mas o resultado só ficou no disco daqui — no servidor
 * ele morava em memória e num arquivo que o Render apaga a cada deploy. Este
 * script traz esse trabalho para dentro do banco em vez de mandar refazer.
 *
 * Fala com o mesmo armazenamento do servidor, então funciona tanto contra o
 * Supabase quanto contra o arquivo local, conforme o .env.
 */

import { readFileSync } from "node:fs";
import { dirname, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { carregaEnv } from "../env.mjs";
import { abreArmazenamento } from "../armazenamento.mjs";
import { normalizaMapa, valida, sha1 } from "../mapa.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
carregaEnv(resolve(RAIZ, ".env"));

function parseArgs(argv) {
  const args = { arquivo: null, email: null, nome: null, objetivo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") args.email = argv[++i];
    else if (a === "--nome") args.nome = argv[++i];
    else if (a === "--objetivo") args.objetivo = argv[++i];
    else if (a.startsWith("-")) throw new Error(`opção desconhecida: ${a}`);
    else if (!args.arquivo) args.arquivo = a;
    else throw new Error(`argumento extra: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.arquivo || !args.email) {
  console.log(`
Semeia um mapa pronto na conta de um usuário.

  node ferramentas/semear.mjs <mapa.json> --email <e-mail> [--nome "..."] [--objetivo "..."]

O e-mail precisa ser de uma conta que já existe. O nome, se omitido, sai do
título do mapa.
`);
  process.exit(1);
}

const dados = abreArmazenamento();
console.log(`armazenamento: ${dados.tipo}\n`);

const email = args.email.trim().toLowerCase();
const usuario = await dados.achaUsuarioPorEmail(email);
if (!usuario) {
  console.error(`✗ não existe conta com o e-mail ${email}.`);
  console.error("  Crie a conta pelo app primeiro — este script não cria usuários.");
  process.exit(1);
}

const bruto = JSON.parse(readFileSync(args.arquivo, "utf8"));

// O nome do arquivo vira o nome da fonte: é a única pista de origem que sobrou
// nesses mapas antigos, e sem fonte nenhuma o mapa não passa na validação.
const nomeArquivo = `${basename(args.arquivo, extname(args.arquivo))}.pdf`;
const mapa = normalizaMapa(bruto, {
  nome: nomeArquivo,
  quando: new Date().toISOString(),
  hash: sha1(readFileSync(args.arquivo)),
});

const erros = valida(mapa);
if (erros.length) {
  console.error(`✗ o mapa não passou na validação:\n  - ${erros.join("\n  - ")}`);
  process.exit(1);
}

const teia = await dados.criaTeia({
  usuario_id: usuario.id,
  nome: args.nome || mapa.titulo,
  objetivo: args.objetivo ?? null,
  foco: null,
  mapa,
});

console.log(`✓ teia "${teia.nome}" criada para ${email}`);
console.log(`  ${mapa.notas.length} notas · ${mapa.grupos.length} grupos · fonte: ${nomeArquivo}`);
console.log(`  id: ${teia.id}`);
