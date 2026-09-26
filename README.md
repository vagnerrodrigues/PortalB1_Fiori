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
| **Compras** | Solicitação de compra, aprovação, efetivação, acompanhamento | PurchaseRequests (OPRQ), Drafts (ODRF), ApprovalRequests (OWDD) |
| **Parceiros de negócio** | Consulta de clientes/fornecedores/leads (nome, código ou CNPJ/CPF), detalhe com endereços e contatos, cadastro de Lead com consulta à Receita e bloqueio de duplicidade | BusinessPartners (OCRD), BPFiscalTaxIDCollection (CRD7), BPAddresses (CRD1), ContactEmployees (OCPR) |
| **Despesas** | Prestação de contas/reembolso: data, categoria, descrição, valor, centro de custo e comprovantes. Vai como solicitação de compra de **serviço**, com conta contábil por categoria, pelo mesmo procedimento de autorização de Compras | PurchaseRequests (DocType dDocument_Service), Attachments2 |
| **Relatórios** | Catálogo com filtros, totais e exportação CSV (Excel pt-BR). Relatórios extras por cliente via JSON, sem programar | SQLQueries (consulta registrada no B1, só SELECT) |

Relatórios padrão: contas a receber em aberto, contas a pagar em aberto, vendas por cliente, compras por fornecedor, solicitações em aberto, estoque por depósito.

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
| `aprovador` | Tudo (superusuário) e aprova as solicitações |

## Produção

- **Windows Server:** `deploy/windows/LEIA-ME.md` (serviço Windows + IIS com HTTPS)
- **Outros ambientes:** `cp config/tenants.example.json config/tenants.json`, preencher e rodar `npm start` atrás de HTTPS com `COOKIE_SECURE=1`

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

## Identidade visual (white-label)

Cores, logo e nome vêm de `config/branding.json` (modelo em `branding.example.json`). A logo fica em `config/brand/`. Cada empresa pode ter a sua marca com `"branding": { ... }` no `tenants.json`. Sem configuração, o portal usa a identidade Blue Ocean (azul-marinho #070070, azul da onda #035DD0 e logo oficial) sobre o tema SAP Horizon.
