# Portal B1

Portal web modular sobre o SAP Business One. É um núcleo único (login, empresas, acesso, auditoria) e módulos que se ligam por cliente. Front SAPUI5 (Fiori, tema Horizon) e BFF em Node.js na frente do Service Layer.

**Princípio:** zero UDF/UDT. Regras de negócio, alçadas e permissões ficam no B1. O portal é só a interface.

```
SAPUI5 (webapp/)  →  Núcleo Node (server/)  →  Service Layer B1  →  HANA / SQL
                        ├─ core/      login, sessão, empresas, acesso por módulo, auditoria, SQLQueries
                        └─ modules/   compras · despesas · parceiros · relatorios  (cada um: rotas + adaptador SL + mock)
```

## Módulos

| Módulo | O que faz | Objetos nativos B1 |
|---|---|---|
| **Compras** | Solicitação → cotação online → oferta → pedido, contratos guarda-chuva e aprovação de todos os documentos | PurchaseRequests (OPRQ), PurchaseQuotations (OPQT), PurchaseOrders (OPOR), BlanketAgreements (OOAT), Drafts (ODRF), ApprovalRequests (OWDD) |
| **Parceiros de negócio** | Consulta de clientes/fornecedores/leads (nome, código ou CNPJ/CPF), detalhe com endereços e contatos, cadastro de Lead com consulta à Receita e bloqueio de duplicidade | BusinessPartners (OCRD), BPFiscalTaxIDCollection (CRD7), BPAddresses (CRD1), ContactEmployees (OCPR) |
| **Despesas** | Prestação de contas/reembolso: data, categoria, descrição, valor, centro de custo e comprovantes. Vai como solicitação de compra de **serviço**, com conta contábil por categoria, pelo mesmo procedimento de autorização de Compras | PurchaseRequests (DocType dDocument_Service), Attachments2 |
| **Relatórios** | Catálogo com filtros, totais e exportação CSV (Excel pt-BR). Relatórios extras por cliente via JSON, sem programar | SQLQueries (consulta registrada no B1, só SELECT) |

Relatórios padrão: contas a receber em aberto, contas a pagar em aberto, vendas por cliente, compras por fornecedor, solicitações em aberto, estoque por depósito.

## Compras: ciclo completo

| Tela | Quem vê | O que faz no B1 |
|---|---|---|
| Nova solicitação / Solicitações de compra | todos com acesso a Compras | OPRQ (retida em rascunho se houver procedimento de autorização) |
| **Cotações online** | compradores | Uma **Oferta de compra (OPQT)** por fornecedor, com base nas linhas da solicitação (`BaseType 1470000113`) |
| Ofertas de compra | compradores | Lista e detalhe das OPQT |
| Pedidos de compra | compradores | OPOR manual, a partir da oferta vencedora (`BaseType 540000006`) ou consumindo contrato (`AgreementNo`) |
| Contratos guarda-chuva | compradores | BlanketAgreements: criar, suspender, encerrar, acompanhar o consumo (planejado × consumido × saldo) |
| Aprovações de compras | aprovadores | Solicitação, oferta e pedido, pelos Procedimentos de Autorização nativos |

**Compradores:** configure em `tenants.json`. Sem essa regra, todo mundo que acessa Compras vê as telas de comprador. Superusuário sempre vê.
```json
"moduleAccess": { "compras": { "departments": [1, 2, 4], "buyers": { "departments": [4], "users": ["joao"] } } }
```

### Cotação online, passo a passo
1. O comprador escolhe as linhas das solicitações em aberto (ou itens avulsos), os fornecedores e o prazo.
2. Para cada fornecedor, o portal cria a Oferta de compra no B1 e envia por e-mail um **link exclusivo** (`/cotacao/<token>`). Sem e-mail no cadastro do fornecedor (campo E-mail do PN), dá para copiar o link e mandar por WhatsApp.
3. O fornecedor informa preço, entrega, condição de pagamento, frete e validade, **sem login**. Também pode marcar "não tenho este item" ou declinar. Itens iguais vindos de solicitações diferentes aparecem somados e são cotados uma vez só.
4. A resposta é gravada na Oferta de compra (preço, `ShipDate`, `DocDueDate` = validade, `NumAtCard` = nº da proposta, condições em `Comments`) **com a sessão do comprador**, quando ele abre o mapa ou clica em "Atualizar SAP". O portal não guarda senha de usuário técnico do B1.
5. **Mapa de cotação:** mostra o menor preço por item, o melhor fornecedor único e o ganho de dividir a compra. O comprador escolhe o vencedor de cada item e também pode lançar propostas recebidas por telefone ou PDF.
6. **Gerar pedidos:** cria um pedido por fornecedor vencedor, copiado da oferta, e fecha as ofertas de quem não ganhou nenhum item. Pedido acima da alçada vai para aprovação normalmente.

O que fica no portal (`data/rfq/<empresa>/`) é só o convite, o token, o status das respostas e a escolha do vencedor. Preços e documentos ficam no B1. **Inclua a pasta `data` no backup.**

**Publicação:** para o fornecedor abrir o link, publique na internet **apenas** a rota `/cotacao/*` e `/api/public/*` (com HTTPS) e preencha o **Endereço público** em Configurações. O resto do portal pode continuar só na rede interna.

## Anexos (nativos do B1)

Solicitação de compra e Despesas aceitam até 5 arquivos de até 10 MB (PDF, imagens, XML, Office, ZIP). O portal grava no objeto **Attachments2** e vincula ao documento pelo `AttachmentEntry`, que aparece na aba **Anexos** do client B1 e acompanha o rascunho quando ele vira documento.

**Pré-requisito:** a pasta de anexos precisa estar definida em *Parametrizações gerais › Caminho*, e o **Service Layer precisa ter permissão de gravação nela**. Em B1 HANA o SL roda em Linux, então a pasta tem que estar montada no servidor do SL.

## Despesas: configuração

```json
"expenseCategories": [
  { "code": "KM",   "name": "Quilometragem", "account": "<Code da conta no plano de contas>" },
  { "code": "REF",  "name": "Refeição",      "account": "..." },
  { "code": "OUT",  "name": "Outras despesas" }
],
"expenseRequireAttachment": true
```

Categoria sem `account` faz o usuário escolher a conta contábil na tela. As aprovações de despesas aparecem em **Compras › Aprovações pendentes**, porque o objeto do B1 é o mesmo, então o aprovador precisa de acesso ao módulo Compras.

## Acesso por usuário (dados nativos do OUSR)

- Superusuário do B1 vê todos os módulos contratados pela empresa.
- Os demais usuários são filtrados por **Departamento** e/ou código de usuário (`moduleAccess` no `tenants.json`).
- A API bloqueia o módulo (403) e a tela também. Toda ação roda com o usuário B1 da pessoa, então as autorizações do próprio B1 continuam valendo.

## Configurações do portal (tile "Configurações do portal")

Só aparece para **superusuário do B1** (ou para quem estiver em `moduleAccess.admin.users`). É por empresa e fica em `config/settings/<empresa>.json`.

| Aba | O que configura |
|---|---|
| **Geral** | Nome do portal (substitui "Portal B1" no login, no cabeçalho e nos e-mails) e o endereço público, usado nos links dos e-mails |
| **E-mail** | Servidor SMTP com os presets Microsoft 365 (smtp.office365.com:587 STARTTLS), Gmail (smtp.gmail.com:465 SSL) e Outro. Tem o botão **Salvar e enviar teste** |
| **Notificações** | Liga/desliga cada etapa: aprovação pendente (vai para o aprovador), aprovada, reprovada e gerada no SAP (vão para o solicitante) |

- Os destinatários vêm do campo **E-mail do usuário no B1** (OUSR). Usuário sem e-mail não recebe.
- A senha do SMTP fica gravada criptografada (AES-256-GCM) com a chave `config/secret.key`, que é gerada na primeira execução. **Faça backup desse arquivo**: sem ele, será preciso digitar a senha de novo.
- O envio acontece em segundo plano. Se o e-mail falhar, a operação no B1 não é afetada, e a falha vai para o log e para a auditoria (`EMAIL`).
- No Microsoft 365, a conta remetente precisa ter o *SMTP AUTH* habilitado. No Gmail, é preciso usar uma *senha de app*.
- No modo demo (mock), os e-mails não saem: eles ficam em `logs/outbox/*.html`.

## Rodar a demo (sem SAP)

```bash
npm install
npm run dev:mock        # http://localhost:8080
npm test                # testes ponta a ponta (mock)
```

| Usuário (senha 1234) | Vê |
|---|---|
| `requisitante` | Compras + Despesas + Relatórios |
| `comercial` | Despesas + Parceiros + Relatórios |
| `comprador` | Compras completo (cotação online, ofertas, pedidos, contratos) + Despesas + Relatórios |
| `aprovador` | Tudo (superusuário) e aprova as solicitações |

## Produção

- **Windows Server:** `deploy/windows/LEIA-ME.md` (serviço Windows + IIS com HTTPS)
- **Outros ambientes:** `cp config/tenants.example.json config/tenants.json`, preencher e rodar `npm start` atrás de HTTPS com `COOKIE_SECURE=1`

### Desempenho
- Conexões com o Service Layer são reaproveitadas (keep-alive) e compactadas (gzip).
- A busca de itens roda num catálogo em memória (itens de compra ativos), carregado em segundo plano quando o usuário abre a tela inicial e atualizado a cada 15 min (`ITEM_CACHE_MIN`). Item recém-cadastrado no B1 aparece na próxima atualização.
- As linhas abertas das solicitações (cotação) vêm de uma única consulta SQLQueries (`PB_PR_OPEN_LINES`).
- Chamadas ao SL acima de 1,5 s (`SL_SLOW_MS`) aparecem em `logs\service.log` como `[sl] lento: … ms`.

## Adicionar um módulo novo

1. Criar `server/modules/<id>/index.js` exportando `{ id, title, tiles, createRouter }` + adaptadores `sl.js` / `mock.js`
2. Registrar o id em `server/index.js` (`registry`)
3. Criar as telas em `webapp/modules/<id>/` e as rotas `<id>.<tela>` no `manifest.json`

O launchpad, o controle de acesso e a auditoria já funcionam para o módulo novo sem mais código.

## Itens a validar na PoC com o primeiro cliente

1. **Retorno do Service Layer ao disparar a aprovação. Validado no B1 10.0 (SL 1000321):** o SL responde "No matching records found (ODBC -2028)" e grava o rascunho (ODRF); o adaptador detecta o rascunho novo e segue o fluxo de aprovação.
   - **Centro de custo:** a linha usa regra de distribuição (OOCR). O centro padrão `Centr_z` não tem regra e também gera -2028, por isso o portal lista `DistributionRules`.
2. **SQLQueries.** Confirmar se o SL do cliente aceita criar consultas com o usuário logado (permissão), a sintaxe de parâmetros (`ParamList`) e GROUP BY na versão instalada.
3. **Licenciamento / acesso indireto.** Confirmar com a SAP a licença mínima por perfil de usuário do portal.
4. **Multi-filial.** Validado no B1 10.0: com filiais ativas, a solicitação exige `BPL_IDAssignedToInvoice` (sem ela o SL devolve -2028). O portal pede a filial, escolhe a série da filial via `SeriesService_GetDocumentSeries` e filtra os depósitos da filial.
5. **CRD7 (CNPJ).** No B1 10.0 testado, o SL recusa SQL na CRD7 ("Table 'CRD7' not accessible"). A checagem de duplicidade tenta, nessa ordem: SQLQueries na CRD7 → filtro `BPFiscalTaxIDCollection/any` → `FederalTaxID`. Para a checagem mais precisa, libere a CRD7 no `b1s_sqltable.conf` do Service Layer. A consulta à Receita (BrasilAPI) roda independente da checagem.
6. **Cotação / pedido / contrato (a validar no B1 real):** criação da OPQT com base na OPRQ e preço 0; PATCH das linhas da oferta com a resposta; cópia oferta → pedido; campos do `BlanketAgreements` (`AgreementMethod`, `Status`, `BlanketAgreements_ItemsLines`, `CumulativeQuantity`) e o vínculo `AgreementNo`/`AgreementRowNumber` na linha do pedido. O agrupamento nativo do relatório "Comparação de ofertas de compra" (Nº do grupo) não é preenchido: a comparação fica no mapa do portal.

## Identidade visual (white-label)

Cores, logo e nome vêm de `config/branding.json` (modelo em `branding.example.json`). A logo fica em `config/brand/`. Cada empresa pode ter a sua marca com `"branding": { ... }` no `tenants.json`. Sem configuração, o portal usa a identidade Blue Ocean (azul-marinho #070070, azul da onda #035DD0 e logo oficial) sobre o tema SAP Horizon.
