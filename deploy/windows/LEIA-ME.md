# Instalação no Windows Server

Arquitetura no servidor:

```
Usuário (navegador/celular)
   │ HTTPS 443
   ▼
IIS (certificado SSL + proxy reverso)          ← setup-iis.ps1
   │ http://127.0.0.1:18080 (só local)
   ▼
Serviço Windows "Portal B1" (Node)  ← install-service.ps1
   │ HTTPS 50000
   ▼
SAP B1 Service Layer
```

## Requisitos do servidor

| Item | Observação |
|---|---|
| Windows Server 2016, 2019, 2022 ou 2025 | 2 vCPU / 4 GB já atendem dezenas de usuários |
| Node.js 20 LTS ou 22 LTS (x64) | https://nodejs.org → instalador .msi |
| NSSM (nssm.exe, win64) | https://nssm.cc/download → copiar `nssm.exe` para esta pasta |
| IIS + URL Rewrite 2.1 + Application Request Routing 3 | Só para produção com HTTPS |
| Certificado SSL do domínio (ex.: portal.cliente.com.br) | Importado em "Computador Local › Pessoal" |
| Rede: servidor → Service Layer na porta 50000 | Testar: `Test-NetConnection servidor-b1 -Port 50000` |

**Ideal:** instalar no próprio servidor do SAP B1 ou na mesma rede, porque a latência com o Service Layer é o que mais pesa no desempenho.

## Passo a passo (produção)

Abra o **PowerShell como Administrador** na pasta `deploy\windows` do pacote.

```powershell
# 0. (uma vez) liberar execução de scripts nesta sessão
Set-ExecutionPolicy -Scope Process Bypass

# 1. Primeira execução: cria C:\PortalB1\config\tenants.json e para
.\install-service.ps1 -BehindIIS

# 2. Edite C:\PortalB1\config\tenants.json (URL do Service Layer + CompanyDB)

# 3. Rode de novo: instala o serviço, sobe e testa
.\install-service.ps1 -BehindIIS

# 4. Publica no IIS com HTTPS
.\setup-iis.ps1 -HostName portal.cliente.com.br -CertThumbprint "<thumbprint do certificado>"
```

Para pegar o thumbprint do certificado:

```powershell
Get-ChildItem Cert:\LocalMachine\My | Select Subject, Thumbprint, NotAfter
```

## Demo rápida (sem SAP, sem IIS)

```powershell
.\install-service.ps1 -Mock
# acesse http://<ip-do-servidor>:18080 com usuário requisitante, comercial ou aprovador / senha 1234
```

## Exemplo de tenants.json

```json
[
  {
    "id": "matriz",
    "name": "Cliente Ltda",
    "serviceLayerUrl": "https://srv-b1:50000/b1s/v1",
    "companyDB": "SBO_CLIENTE_PRD",
    "rejectUnauthorized": false
  }
]
```

`rejectUnauthorized: false` aceita o certificado autoassinado padrão do Service Layer. Se o Service Layer tiver um certificado válido, use `true`.

## Módulos e acesso por usuário

No `tenants.json`, cada empresa define os módulos contratados e quem acessa cada um. Tudo é baseado em dados nativos do usuário B1:

```json
"modules": ["compras", "parceiros", "relatorios"],
"moduleAccess": {
  "compras":   { "departments": [1, 2] },
  "parceiros": { "departments": [3], "users": ["gerente"] }
},
"bpLeadSeries": 72,
"reports": ["receber-aberto", "pagar-aberto", "vendas-cliente"]
```

- **Superusuário do B1** vê todos os módulos contratados.
- **departments** = código do Departamento do usuário (Administração › Definição › Geral › Departamentos).
- Módulo sem regra = liberado para todos os usuários da empresa.
- **bpLeadSeries** = série de numeração de PN para leads (opcional; sem ela o código é gerado como L + data/hora).
- **reports** = relatórios disponíveis (opcional; sem ela, todos). Relatórios extras sem programação: `config\reports.json` (modelo em `reports.example.json`).

## Logo e cores

1. Copie a logo (PNG ou SVG, fundo transparente, boa leitura sobre azul-escuro) para `C:\PortalB1\config\brand\`
2. Crie `C:\PortalB1\config\branding.json` a partir de `branding.example.json`, ajustando `logo` e `colors`
3. `Restart-Service PortalB1` e atualize o navegador (Ctrl+F5)

## Atualizando da versão "Portal de Compras"

Rode `.\install-service.ps1` do pacote novo. Ele remove o serviço antigo `PortalComprasB1`, aproveita o `tenants.json` e instala o `PortalB1` na porta 18080.

## Operação do dia a dia

| Ação | Comando |
|---|---|
| Status | `Get-Service PortalB1` |
| Reiniciar | `Restart-Service PortalB1` |
| Logs do serviço | `C:\PortalB1\logs\service.log` e `service-error.log` (rotação a cada 10 MB) |
| Auditoria (quem fez o quê) | `C:\PortalB1\logs\audit.log` |
| Atualizar versão | Extrair o pacote novo e rodar `.\install-service.ps1 -BehindIIS` de novo (preserva o tenants.json e os logs) |
| Remover | `.\uninstall-service.ps1` |

O serviço inicia com o Windows e reinicia sozinho em caso de falha. Ao reiniciar o serviço, os usuários logados precisam entrar de novo (a sessão da Fase 1 fica em memória).

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| "Falha de conexão com o Service Layer" | Porta 50000 bloqueada ou URL errada no tenants.json |
| Login no B1 recusado | Usuário/senha do B1, CompanyDB errado ou usuário sem licença |
| 502 no IIS | Serviço parado (`Get-Service PortalB1`) ou proxy do ARR desabilitado |
| Login funciona e cai logo em seguida | Acesso por HTTP com `-BehindIIS` (cookie Secure exige HTTPS) |
| Tela em branco | O navegador do usuário não alcança `ui5.sap.com` (a biblioteca SAPUI5 é carregada da CDN da SAP) |
