Você já identificou que a fonte nova reforça as notas abaixo. Agora **reescreva
essas notas** incorporando o que a fonte nova acrescenta.

Você recebe a fonte nova e, para cada nota, o texto que ela tem hoje. As fontes
antigas **não** vêm junto, e não precisam: o texto atual já é o que elas
renderam. Sua tarefa é somar, não refazer do zero.

Devolva um objeto com `notas`, um item por nota pedida, cada um com `id` (igual
ao pedido) e `conteudo` (o markdown completo e revisado da nota).

## O que "enriquecer" quer dizer

Devolva a nota **inteira**, não um trecho. O que você devolver substitui o
texto atual.

Preserve o que já está certo. Se a fonte nova não muda nada em algum parágrafo,
esse parágrafo volta igual. Reescrever bem escrito é perda: gasta a chamada e
corre o risco de piorar.

O que a fonte nova pode acrescentar:

- **um exemplo concreto** — enunciado de exercício, caso, número real;
- **uma distinção** que a nota tratava de forma vaga;
- **uma ênfase** — se a fonte insiste num ponto, ele merece destaque;
- **uma correção** — se a fonte nova contradiz o texto atual, veja abaixo.

## Quando as fontes discordam

Não escolha um lado em silêncio. Registre a divergência:

> A apostila trata o prazo como 15 dias corridos; a aula da professora fala
> em 15 dias úteis.

Isso é informação valiosa para quem estuda — some as duas versões e siga. O
silêncio é que seria erro: some uma informação sem que ninguém saiba.

## Limites

- **Não invente.** Se a fonte nova não cobre um ponto, deixe como está.
- Não escreva "a fonte nova diz que...". O leitor não quer saber da mecânica
  do app; quer a matéria.
- Não deixe a nota crescer sem limite: continue entre 150 e 400 palavras. Se o
  acréscimo não couber, ele não era essencial.
- Não escreva seção "Relacionado" nem links entre notas: isso é gerado
  automaticamente a partir do mapa.

## Formato do texto — leia com atenção

O campo `conteudo` é **markdown**, e markdown depende de quebras de linha
reais para funcionar. Título, lista e tabela são estruturas de linha: coladas
no meio de um parágrafo, elas não viram nada — aparecem como `##` e `1.` soltos
na tela do leitor.

Então:

- Deixe **uma linha em branco** antes e depois de cada título, lista, tabela,
  citação e bloco de código.
- Cada item de lista e cada linha de tabela fica na sua própria linha.
- Use `##` para subdivisões. Nunca use `#` (o h1 é o título da nota).
- **Nunca escreva HTML.** Nem `<table>`, nem `<br>`, nem `<b>`. Se precisar de
  tabela, use o formato markdown com barras verticais.
