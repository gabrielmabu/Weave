Você já planejou o mapa deste material. Agora escreva o **conteúdo** das notas
listadas abaixo, usando o PDF como fonte.

Devolva um objeto com `notas`, contendo um item por nota pedida, cada um com
`id` (igual ao pedido) e `conteudo` (markdown).

## Como escrever

Escreva para quem vai **estudar por esta nota**, não para quem já sabe. A
pessoa abriu esta nota porque quer entender este conceito agora.

- 150 a 400 palavras. Denso, sem encher linguiça.
- **Não repita o título** como primeira linha — ele já aparece acima.
- Comece pelo que o conceito é ou faz. Nada de "Neste tópico veremos...".
- Use `##` para subdivisões. Nunca use `#` (o h1 é o título da nota).
- **Negrito** para o termo técnico na primeira vez que aparece, e para
  números que caem em prova (prazos, quóruns, artigos).
- Cite o dispositivo legal quando o material citar (`art. 5º, II`).

## Recursos que valem usar

**Tabela** quando houver comparação entre duas ou mais coisas com os mesmos
critérios. É o formato que mais ajuda na hora de revisar.

**Bloco `mermaid`** para estrutura que se entende melhor vendo do que lendo.

Faça diagrama sempre que a nota descrever um destes casos:

- **etapas em ordem** — um procedimento, um rito, uma sequência de fases
- **decisão com caminhos** — "se X, segue por aqui; se não, por ali"
- **hierarquia ou classificação** — o que se subdivide em quê
- **ciclo** — algo que volta ao início

Se a nota tem uma dessas formas e você a escreveu só em prosa ou lista, o
leitor está fazendo na cabeça um trabalho que o diagrama faria por ele.

Regras: `flowchart TD` para hierarquia e decisão, `flowchart LR` para
sequência. **Máximo 6 nós** — diagrama maior fica ilegível no celular.
Rótulos com no máximo 5 palavras, **sem parênteses e sem pontuação dentro
dos colchetes** (quebram o desenho).

O que não fazer: diagrama de duas caixas ligadas por uma seta não acrescenta
nada — isso é uma frase. E não invente estrutura que o material não tem; se
o conceito é uma definição sem partes móveis, ele não pede desenho.

**Citação `>`** para a pegadinha, a exceção ou o erro comum. Use no máximo
uma por nota, e só quando houver mesmo uma armadilha a sinalizar.

## Formato do texto — leia com atenção

O campo `conteudo` é **markdown**, e markdown depende de quebras de linha
reais para funcionar. Título, lista e tabela são estruturas de linha: coladas
no meio de um parágrafo, elas não viram nada — aparecem como `##` e `1.` soltos
na tela do leitor.

Então:

- Deixe **uma linha em branco** antes e depois de cada título, lista, tabela,
  citação e bloco de código.
- Cada item de lista e cada linha de tabela fica na sua própria linha.
- **Nunca escreva HTML.** Nem `<table>`, nem `<br>`, nem `<b>`. Se precisar de
  tabela, use o formato markdown com barras verticais. Se a estrutura não
  couber em markdown, escreva em prosa — texto corrido é melhor que marcação
  que não funciona.

## Limites

- Escreva **só sobre o conceito daquela nota**. Se ela toca outra da lista,
  mencione em uma frase e siga — a outra nota cobre o resto.
- **Não invente.** Se o PDF não cobre algo, não preencha com conhecimento
  geral. Escreva a nota mais curta com o que o material sustenta.
- Não escreva seção "Relacionado" nem links entre notas: isso é gerado
  automaticamente a partir do mapa.
- Não use `<script>`, HTML cru, nem imagens.
