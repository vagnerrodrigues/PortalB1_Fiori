<#
.SYNOPSIS
  Instala (ou atualiza) o Portal B1 como serviço do Windows usando NSSM.

.EXAMPLE
  # Produção atrás do IIS com HTTPS (recomendado)
  .\install-service.ps1 -BehindIIS

  # Demo sem SAP, acessível direto na porta 18080
  .\install-service.ps1 -Mock

.NOTES
  Executar em PowerShell como Administrador, a partir da pasta deploy\windows do pacote.
  Rodar de novo = atualização (preserva config\tenants.json e logs).
#>
[CmdletBinding()]
param(
  [string]$InstallDir  = "C:\PortalB1",
  [int]   $Port        = 18080,
  [string]$ServiceName = "PortalB1",
  [string]$NssmPath    = (Join-Path $PSScriptRoot "nssm.exe"),
  [switch]$Mock,
  [switch]$BehindIIS
)

# Continue: no Windows PowerShell 5.1, avisos em stderr de npm/nssm viram erro fatal com "Stop".
# Falhas reais são tratadas por $LASTEXITCODE e throw explícito.
$ErrorActionPreference = "Continue"
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- 0. Pré-checagens -------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Execute este script como Administrador." }

Step "Verificando Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js não encontrado. Instale o Node.js 20 LTS ou 22 LTS (https://nodejs.org) e abra um novo PowerShell." }
$nodeVersion = (& node -v).TrimStart("v")
if ([int]($nodeVersion.Split(".")[0]) -lt 18) { throw "Node.js $nodeVersion é antigo. Use 20 LTS ou superior." }
Write-Host "Node.js $nodeVersion em $($node.Source)"

if (-not (Test-Path $NssmPath)) {
  throw "nssm.exe não encontrado em $NssmPath. Baixe em https://nssm.cc/download (win64\nssm.exe) e coloque nesta pasta."
}

$source = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# --- 1a. Migração da versão anterior (Portal de Compras B1) ----------------
$legacy = Get-Service -Name "PortalComprasB1" -ErrorAction SilentlyContinue
if ($legacy) {
  Step "Removendo serviço antigo PortalComprasB1 (versão anterior)"
  & $NssmPath stop PortalComprasB1 | Out-Null
  & $NssmPath remove PortalComprasB1 confirm | Out-Null
  $oldTenants = "C:\PortalComprasB1\config\tenants.json"
  if ((Test-Path $oldTenants) -and -not (Test-Path (Join-Path $InstallDir "config\tenants.json"))) {
    New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "config") | Out-Null
    Copy-Item $oldTenants (Join-Path $InstallDir "config\tenants.json")
    Write-Host "tenants.json da versão anterior aproveitado."
  }
}

# --- 1. Parar serviço existente (atualização) -------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Step "Serviço existente encontrado: parando para atualizar"
  & $NssmPath stop $ServiceName | Out-Null
}

# --- 2. Copiar arquivos -----------------------------------------------------
Step "Copiando aplicação para $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir -ErrorAction Stop | Out-Null
if ($source -ne $InstallDir) {
  robocopy $source $InstallDir /E /NFL /NDL /NJH /NJS /XD node_modules logs .git /XF tenants.json | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar arquivos (robocopy $LASTEXITCODE)" }
  # tenants.json do pacote só é copiado na primeira instalação (nunca sobrescreve o do servidor)
  $srcTenants = Join-Path $source "config\tenants.json"
  $dstTenants = Join-Path $InstallDir "config\tenants.json"
  if ((Test-Path $srcTenants) -and -not (Test-Path $dstTenants)) { Copy-Item $srcTenants $dstTenants }
}

# --- 3. Dependências --------------------------------------------------------
Step "Instalando dependências (npm ci)"
Push-Location $InstallDir
try {
  & npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "npm ci falhou" }
} finally { Pop-Location }

# --- 4. Configuração de empresas --------------------------------------------
$tenants = Join-Path $InstallDir "config\tenants.json"
if (-not $Mock -and -not (Test-Path $tenants)) {
  Copy-Item (Join-Path $InstallDir "config\tenants.example.json") $tenants -ErrorAction Stop
  Write-Warning "Criado $tenants a partir do exemplo. Preencha serviceLayerUrl e companyDB e rode o script de novo."
  exit 1
}

# --- 5. Serviço Windows (NSSM) ----------------------------------------------
Step "Configurando serviço $ServiceName"
$logs = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

if (-not $existing) {
  & $NssmPath install $ServiceName $node.Source "server\index.js" | Out-Null
}
$hostBind = if ($BehindIIS) { "127.0.0.1" } else { "0.0.0.0" }
$envVars = @("NODE_ENV=production", "PORT=$Port", "HOST=$hostBind")
if ($BehindIIS) { $envVars += "COOKIE_SECURE=1" }
if ($Mock)      { $envVars += "MOCK=1" }

& $NssmPath set $ServiceName Application $node.Source | Out-Null
& $NssmPath set $ServiceName AppParameters "server\index.js" | Out-Null
& $NssmPath set $ServiceName AppDirectory $InstallDir | Out-Null
& $NssmPath set $ServiceName AppEnvironmentExtra $envVars | Out-Null
& $NssmPath set $ServiceName DisplayName "Portal B1" | Out-Null
& $NssmPath set $ServiceName Description "Portal B1 integrado ao SAP Business One (Compras, Parceiros, Relatórios)" | Out-Null
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000 | Out-Null
& $NssmPath set $ServiceName AppStdout (Join-Path $logs "service.log") | Out-Null
& $NssmPath set $ServiceName AppStderr (Join-Path $logs "service-error.log") | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateOnline 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null

# --- 6. Firewall (só quando exposto direto, sem IIS) ------------------------
if (-not $BehindIIS) {
  $ruleName = "Portal B1 ($Port)"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    Step "Liberando porta $Port no firewall"
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
  }
  if (-not $Mock) { Write-Warning "Sem IIS/HTTPS as senhas trafegam sem criptografia. Use -BehindIIS em produção." }
}

# --- 7. Subir e testar -------------------------------------------------------
Step "Iniciando serviço"
& $NssmPath start $ServiceName | Out-Null
if ((Get-Service $ServiceName).Status -ne "Running") { Start-Sleep -Seconds 3 }
Start-Sleep -Seconds 3
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 10 -ErrorAction Stop
  Write-Host "`nOK: portal no ar (modo: $($health.mode); módulos: $($health.modules -join ', ')) em http://127.0.0.1:$Port" -ForegroundColor Green
} catch {
  Write-Warning "O serviço não respondeu. Veja $logs\service-error.log"
  exit 1
}
