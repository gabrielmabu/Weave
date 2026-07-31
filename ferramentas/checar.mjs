/**
 * Confere se o ambiente está pronto antes de subir.
 *
 * Existe para que "não funcionou" vire "falta a variável X" ou "a tabela Y não
 * foi criada". Descobrir isso pelo log do Render, depois do deploy, custa muito
 * mais tempo do que rodar isto aqui.
 *
 *   node ferramentas/checar.mjs
 *
 * Não imprime nenhuma credencial — só diz se está lá e se funciona.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { carregaEnv } from "../env.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(RAIZ, ".env"))) console.log("· sem arquivo .env — lendo só do ambiente\n");
const env = carregaEnv(join(RAIZ, ".env"));

let problemas = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const erro = (msg) => { console.log(`  ✗ ${msg}`); problemas++; };
const nota = (msg) => console.log(`    ${msg}`);

// ------------------------------------------------------------- variáveis

console.log("Variáveis obrigatórias");

const obrigatorias = [
  ["GEMINI_API_KEY", "sem ela nenhum mapa é gerado"],
  ["CODIGO_CONVITE", "sem ele o servidor se recusa a subir"],
];
for (const [nome, porque] of obrigatorias) {
  if (env[nome]) ok(`${nome} definida (${env[nome].length} caracteres)`);
  else erro(`${nome} ausente — ${porque}`);
}

console.log("\nVariáveis recomendadas");
if (env.ADMIN_EMAIL) ok(`ADMIN_EMAIL = ${env.ADMIN_EMAIL}`);
else {
  console.log("  ~ ADMIN_EMAIL ausente");
  nota("ninguém verá o log de acesso completo; cada um só vê o próprio");
}

// ------------------------------------------------------------- supabase

console.log("\nBanco");

const url = env.SUPABASE_URL;
const chave = env.SUPABASE_SERVICE_KEY;

if (!url || !chave) {
  console.log("  ~ Supabase não configurado — usando arquivo local");
  nota("serve para rodar aqui. No Render o disco é apagado a cada deploy,");
  nota("e usuários e log sumiriam junto.");
} else {
  // Erro fácil: copiar o endereço do painel em vez do da API. Os dois começam
  // com https e parecem certos, mas o do painel devolve HTML, não dados — e o
  // erro sai como "resposta não é JSON", que não aponta para a causa.
  if (/supabase\.com\/dashboard/.test(url)) {
    erro("SUPABASE_URL é o endereço do painel, não o da API");
    const ref = url.match(/\/project\/([a-z0-9]+)/)?.[1];
    nota(ref ? `use: https://${ref}.supabase.co` : "use: https://<ref-do-projeto>.supabase.co");
    nota("está em Settings → Data API");
  } else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/.test(url)) {
    console.log(`  ~ SUPABASE_URL = ${url}`);
    nota("formato fora do esperado (https://<ref>.supabase.co); o teste abaixo dirá");
  } else {
    ok(`SUPABASE_URL = ${url}`);
  }
  ok(`SUPABASE_SERVICE_KEY definida (${chave.length} caracteres)`);

  // A chave pública também autentica, mas o RLS do esquema bloqueia tudo por
  // ela — o app subiria e falharia só na primeira gravação, o que é pior do
  // que falhar agora.
  //
  // O Supabase tem dois formatos em circulação: o novo (sb_secret_ /
  // sb_publishable_, opacos) e o antigo (JWT com o papel dentro). O painel
  // hoje mostra o novo por padrão e esconde o antigo numa aba "Legacy".
  if (chave.startsWith("sb_secret_")) {
    ok("é uma Secret key (substitui a antiga service_role)");
  } else if (chave.startsWith("sb_publishable_")) {
    erro("é a Publishable key — o RLS vai barrar tudo");
    nota("use a de 'Secret keys', logo abaixo na mesma página do painel");
  } else if (chave.split(".").length === 3) {
    try {
      const papel = JSON.parse(
        Buffer.from(chave.split(".")[1], "base64").toString("utf8"),
      ).role;
      if (papel === "service_role") ok("é a service_role legada, serve");
      else erro(`a chave é '${papel}', não service_role — o RLS vai barrar tudo`);
    } catch {
      console.log("  ~ chave em formato JWT, mas não consegui ler o papel");
    }
  } else {
    console.log("  ~ formato de chave não reconhecido; o teste abaixo dirá se serve");
  }

  const cabecalhos = { apikey: chave, Authorization: `Bearer ${chave}` };
  for (const tabela of ["usuarios", "sessoes", "acessos"]) {
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${tabela}?limit=1`, {
        headers: cabecalhos,
      });
      if (r.ok) {
        const linhas = await r.json();
        ok(`tabela ${tabela} acessível (${linhas.length} registro(s) na amostra)`);
      } else {
        const corpo = await r.text();
        erro(`tabela ${tabela}: HTTP ${r.status}`);
        nota(corpo.slice(0, 160));
        if (corpo.includes("does not exist")) nota("rode o esquema.sql no SQL Editor");
      }
    } catch (e) {
      erro(`tabela ${tabela}: ${e.message}`);
    }
  }
}

// --------------------------------------------------------------- limites

console.log("\nFreios de gasto");
const teto = Number(env.TETO_TOKENS_POR_RODADA ?? 60000);
console.log(`    teto por rodada: ${teto.toLocaleString("pt-BR")} tokens`);
console.log(`    notas por lote:  ${env.NOTAS_POR_LOTE ?? 12}`);
console.log(`    teto de páginas: ${env.TETO_PAGINAS ?? 60}`);

// ----------------------------------------------------------------- fecho

console.log("");
if (problemas) {
  console.log(`${problemas} problema(s) — resolva antes de subir.`);
  process.exit(1);
}
console.log("Tudo pronto.");
