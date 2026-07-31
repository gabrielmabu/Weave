-- Esquema do Weave no Supabase.
--
-- Cole no SQL Editor do seu projeto e rode uma vez.
--
-- Observação sobre o modelo escolhido: a autenticação é feita pelo próprio
-- servidor do Weave (auth.mjs), não pelo Supabase Auth. O Supabase aqui é
-- banco de dados, e o acesso vem só do servidor com a service key — nunca do
-- navegador. É por isso que RLS fica habilitado sem políticas de leitura
-- pública: qualquer requisição vinda do lado do cliente é negada por padrão.

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------ usuários

create table if not exists usuarios (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  telefone    text not null,
  -- Formato: scrypt$N$r$p$sal$hash. Os parâmetros de custo vão junto para que
  -- aumentar o custo no futuro não invalide os hashes já gravados.
  senha_hash  text not null,
  criado_em   timestamptz not null default now()
);

-- O e-mail é gravado já em minúsculas pelo servidor; o índice garante que
-- ninguém entre por outro caminho e crie "Ana@x.com" além de "ana@x.com".
create unique index if not exists usuarios_email_idx on usuarios (lower(email));

-- ------------------------------------------------------------------ sessões

create table if not exists sessoes (
  token       text primary key,
  usuario_id  uuid not null references usuarios(id) on delete cascade,
  expira_em   timestamptz not null,
  criada_em   timestamptz not null default now()
);

create index if not exists sessoes_usuario_idx on sessoes (usuario_id);
create index if not exists sessoes_expira_idx on sessoes (expira_em);

-- -------------------------------------------------------------- log de acesso

create table if not exists acessos (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references usuarios(id) on delete cascade,
  quando        timestamptz not null default now(),
  job_id        text,
  arquivo       text,
  tamanho_bytes bigint,
  objetivo      text,
  -- Preenchidos quando o trabalho termina: servem para saber quem gastou o quê
  -- do saldo compartilhado com o Anotô.
  estado        text,
  notas         int,
  tokens_entrada int,
  tokens_saida   int,
  erro          text
);

create index if not exists acessos_usuario_idx on acessos (usuario_id);
create index if not exists acessos_quando_idx on acessos (quando desc);
create index if not exists acessos_job_idx on acessos (job_id);

-- ---------------------------------------------------------------------- RLS
-- Nenhuma política é criada de propósito. Com RLS ligado e sem política, o
-- acesso pela chave anônima (a que poderia vazar no navegador) é negado em
-- tudo. A service key usada pelo servidor ignora RLS — então o servidor
-- funciona e o cliente não alcança nada diretamente.

alter table usuarios enable row level security;
alter table sessoes  enable row level security;
alter table acessos  enable row level security;

-- ------------------------------------------------------------------ limpeza
-- Sessão vencida não serve para nada e só acumula. Rode de vez em quando, ou
-- agende no painel do Supabase (Database > Cron).

-- delete from sessoes where expira_em < now();
