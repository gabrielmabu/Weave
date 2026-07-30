Você está lendo um material de estudo. Sua tarefa é planejar um mapa de notas
sobre ele — ainda **sem escrever o conteúdo das notas**, só a estrutura.

## O que produzir

Um índice com grupos e notas.

**Grupos** são as grandes divisões do material (capítulos, temas, blocos).
Use de 3 a 7. Nomeie no formato `01 - Nome do Tema`, com número de dois
dígitos, em ordem de leitura. O nome deve ser o tema em si, não "Capítulo 1".

**Notas** são os conceitos que valem virar cartão de estudo. Cada nota é um
conceito que a pessoa precisa entender e conseguir explicar — não é um
resumo de página nem um título de seção.

### Quantas notas

**Entre 12 e 30 notas. Nunca passe de 30**, por mais denso que o material
pareça.

Esse teto existe por um motivo concreto: cada nota vai receber 150 a 400
palavras de conteúdo próprio. Passar do teto não cobre mais matéria — apenas
divide a mesma matéria em pedaços menores, e o resultado medido é que as
notas ficam **mais rasas**, não mais completas.

Se o material parecer pedir mais de 30 notas, você está separando conceitos
que deveriam estar juntos. **Na dúvida entre separar ou juntar dois conceitos
vizinhos, junte.** Separe apenas quando se distinguirem em prova.

- Uma nota por conceito, não por seção do PDF.
- Não crie nota para prefácio, sumário, bibliografia ou exercícios.

## Campos de cada nota

- `id` — slug em minúsculas, sem acento, palavras separadas por hífen.
  Deriva do título. Exemplo: "Princípio da Legalidade" → `principio-da-legalidade`.
  Precisa ser único. Nunca use `home`, que é reservado.
- `titulo` — o nome do conceito, como se diz em voz alta. Sem numeração.
- `grupo` — exatamente um dos grupos que você listou. Cópia literal.
- `resumo` — **uma linha**, em minúsculas, sem ponto final. É o que aparece
  ao lado do título no índice. Diz o que a nota entrega, não que ela existe.
  Bom: "quem pode propor a ação e em que prazo".
  Ruim: "explica sobre os legitimados".
- `relacionado` — lista de `id`s de outras notas com ligação real.

## Sobre o campo `relacionado` — a parte que mais importa

Esses ids viram as **linhas do gráfico**. É o que transforma uma lista em mapa.

**Cada nota precisa de 2 a 4 ligações. Nenhuma pode ter menos de 2.**

### A regra que define a qualidade do mapa

**Pelo menos uma ligação de cada nota deve apontar para outro grupo.**

Ligação dentro do mesmo grupo é quase gratuita — conceitos vizinhos no
sumário obviamente se relacionam, e dizer isso não informa nada. O gráfico
já mostra os grupos por cor; repetir o agrupamento nas linhas é redundância.

O valor está em **atravessar**: mostrar que um princípio lá do começo é o que
sustenta um procedimento lá do fim. É isso que a pessoa não enxerga lendo
linearmente, e é para isso que o mapa existe.

Antes de fechar sua resposta, confira: se a maioria das suas ligações fica
dentro do mesmo grupo, você desenhou o sumário de novo, não um mapa. Volte
e troque as redundantes por travessias.

### O que conta como ligação real

Ligue quando um conceito **depende** do outro, **se opõe** a ele, é
**exceção** dele, é **aplicação prática** dele, ou é **confundido** com ele
na prática.

Não ligue por proximidade no texto nem por vocabulário parecido.

Todo id citado precisa existir na sua lista de notas — id inventado quebra
o mapa.

Não inclua uma nota `home`: ela é criada automaticamente e ligada a todas.

## Título

`titulo` da raiz é o nome do material, como alguém se referiria a ele em
conversa. Se o PDF tiver título óbvio, use. Senão, deduza do conteúdo.
`subtitulo` é uma linha dizendo do que trata — serve de orientação inicial.
