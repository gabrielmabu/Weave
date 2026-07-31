# Publicar no Render

## 1. Código no GitHub

GitHub e Render fazem coisas diferentes: o GitHub guarda o **código**, o Render **roda o app**. Você usa os dois.

```bash
cd C:\Users\gabriel.burgo\Downloads\weave
git init
git add .
git commit -m "Weave: PDF para mapa mental"
```

Crie um repositório **privado** no GitHub e siga as instruções de `git remote add` que ele mostra.

> Confira antes do primeiro `git push`: `git status` não pode listar `.env`. Ele está no `.gitignore`, mas vale olhar — chave commitada em repositório é chave vazada, mesmo em repositório privado.

## 2. Serviço no Render

Novo **Web Service**, apontando para o repositório.

| Campo | Valor |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** serve — com uma condição |

### Sobre o plano gratuito

O gratuito hiberna após ~15 minutos **sem requisições**. Isso parece incompatível com uma rodada de 5 a 20 minutos, mas não é: a tela consulta o andamento a cada 3 segundos, e essas consultas contam como atividade. **Com a aba aberta, o serviço não dorme.**

A condição, então, é essa: **a aba precisa ficar aberta até o fim**. Fechando antes, a consulta para, o Render hiberna em ~15 min e leva o trabalho junto. A interface avisa disso e o navegador pede confirmação se você tentar fechar com job rodando.

Duas irritações menores do gratuito, nenhuma fatal:

- **Primeiro acesso do dia demora** ~30–60 s para acordar o serviço.
- **750 horas/mês** de teto, o que sobra folgado para uso pessoal.

Se um dia quiser fechar a aba e voltar depois, aí sim precisa do **Starter** (~US$ 7/mês) — nele o serviço não hiberna e o trabalho continua sozinho.

## 3. Variáveis de ambiente

No painel do Render, aba **Environment**:

| Variável | Valor | Observação |
|---|---|---|
| `GEMINI_API_KEY` | sua chave | A mesma do `.env` local. **Nunca vai para o repositório.** |
| `CODIGO_CONVITE` | escolha um | Exigido no cadastro. Sem ele o servidor **se recusa a subir**. |
| `ADMIN_EMAIL` | seu e-mail | Quem enxerga o log de acesso completo. |
| `SUPABASE_URL` | do painel Supabase | |
| `SUPABASE_SERVICE_KEY` | do painel Supabase | A **service_role**, não a anônima. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | |
| `NOTAS_POR_LOTE` | `12` | Principal botão de economia. |
| `TETO_TOKENS_POR_RODADA` | `60000` | Freio de gasto por rodada. |
| `TETO_PAGINAS` | `60` | |
| `TETO_MB` | `18` | |

## 3.1 Banco no Supabase

Contas e log de acesso precisam sobreviver a um deploy, e o disco do Render não sobrevive. Por isso o Supabase.

1. Crie um projeto **novo** em [supabase.com](https://supabase.com) — separado do Anotô, como combinado.
2. **SQL Editor** → cole o conteúdo de [`esquema.sql`](esquema.sql) → *Run*. Cria `usuarios`, `sessoes` e `acessos`.
3. **Settings → API** → copie a *Project URL* e a chave **`service_role`**.

> A `service_role` ignora todas as regras de permissão do banco. Ela vive só nas variáveis do servidor — nunca no navegador, nunca no repositório. A chave `anon`, que poderia aparecer no cliente, não serve aqui e é barrada pelo RLS ligado no esquema.

Sem essas duas variáveis o servidor sobe assim mesmo, gravando num arquivo local, e avisa no log. Serve para rodar na sua máquina; no Render, cada deploy apagaria os usuários.

## 4. Usar

Abra a URL, digite a senha, descreva o objetivo, anexe o PDF.

Pode fechar a aba: o trabalho continua no servidor, e ao voltar com a mesma senha a página reencontra o job em andamento.

---

## O que saber antes de confiar nisso

**O disco do Render é efêmero.** Reinício, deploy ou troca de plano apagam a pasta `trabalho/`. O HTML gerado **some junto**. Baixe assim que ficar pronto — o link não é lugar de guardar arquivo.

**Um job por vez.** A fila é proposital: dois envios simultâneos dobrariam a queima do saldo sem aviso. O segundo espera o primeiro.

**Os jobs vivem na memória.** Se o servidor reiniciar durante um job, ele se perde e a página vai reportar "job não encontrado". O checkpoint em disco também some junto, então não há retomada — é recomeçar. No plano gratuito, fechar a aba antes do fim é justamente o que provoca isso.

**A senha é única e compartilhada.** Protege contra URL vazada virar torneira aberta no seu saldo pré-pago; não identifica quem usou nem separa consumo por pessoa.

**O saldo é dividido com o Anotô.** Mesmo projeto Google (`zapcaixa`). Uma rodada grande aqui consome cota do app de caixa em produção. O freio de 60 mil tokens protege disso, mas quem escolhe o teto é você.
