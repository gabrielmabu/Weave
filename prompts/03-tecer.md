Já existe um mapa de notas sobre este assunto, montado a partir de outras
fontes. Você está lendo uma **fonte nova** para tecê-la nesse mapa.

Isso não é recomeçar. O mapa antigo continua inteiro; sua tarefa é dizer o que
esta fonte **acrescenta** e onde ela **encosta** no que já existe.

## O que você recebe

A fonte nova, e logo abaixo o índice do mapa atual: id, título e o recorte de
cada nota que já está lá. Você não recebe o texto completo dessas notas — não
precisa, porque não vai reescrevê-las aqui.

## O que produzir

### 1. `reforcos` — o que mais importa

Notas que **já existem** e que esta fonte também sustenta.

É a razão de este app existir. Um conceito que a professora deu na aula, que
está na apostila e que cai no exercício vale mais que um que aparece num lugar
só — e é isso que o mapa vai mostrar em destaque.

Para cada uma, devolva o `id` da nota existente e, em `porque`, uma linha
dizendo o que esta fonte diz sobre ela. Não repita o resumo da nota; diga o
que a fonte NOVA acrescenta.

Só marque reforço quando a fonte trata mesmo do conceito. Vocabulário parecido
não basta: se ela só menciona o termo de passagem, não é reforço.

Espere entre 3 e 15 reforços num material relacionado. Zero reforço quer dizer
que esta fonte não conversa com o mapa — o que é possível, mas raro se você
escolheu bem.

### 2. `notasNovas` — o que só esta fonte tem

Conceitos que a fonte cobre e que **não existem** no índice atual.

Antes de criar uma nota nova, procure no índice se o conceito já está lá com
outro nome. **Na dúvida entre criar nota nova e marcar reforço, marque
reforço** — nota duplicada é o pior resultado possível aqui: parte o mapa em
dois pedaços que falam da mesma coisa.

**No máximo 15 notas novas.** Se a fonte parecer pedir mais, ela é material
para uma teia própria, não para esta.

Campos, iguais aos do mapa existente:

- `id` — slug em minúsculas, sem acento, hífen entre palavras. Único, e
  diferente de todos os ids do índice. Nunca `home`.
- `titulo` — o nome do conceito, como se diz em voz alta.
- `grupo` — de preferência um grupo que **já existe** no mapa, copiado
  literalmente. Só proponha grupo novo se o conceito realmente não couber em
  nenhum, e nesse caso liste o nome em `gruposNovos`.
- `resumo` — uma linha, minúsculas, sem ponto final.
- `relacionado` — ids com ligação real.

### 3. Ligações — onde a teia se fecha

O campo `relacionado` das notas novas pode citar **duas coisas**:

- ids de outras notas novas suas;
- **ids de notas que já existem no índice** — e é isto que interessa.

Uma nota nova que só se liga a outras notas novas cria uma ilha: um pedaço
solto pendurado no mapa. Cada nota nova precisa de **pelo menos uma ligação
para uma nota que já existia**, e de 2 a 4 ligações no total.

Todo id citado precisa existir — ou no índice que você recebeu, ou entre as
suas notas novas. Id inventado quebra o mapa.

### 4. `gruposNovos`

Só os grupos que você propôs e que ainda não estão no mapa. Mesmo formato dos
existentes: `NN - Nome do Tema`. Se todos os conceitos couberam nos grupos que
já havia, devolva lista vazia — que é o desfecho preferível.
