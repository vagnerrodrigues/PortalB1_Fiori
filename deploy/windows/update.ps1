<#
.SYNOPSIS
  Atualiza o Portal B1 a partir do GitHub: git pull + reinstalação do serviço + teste de saúde.

.EXAMPLE
  .\update.ps1                  # atualiza para a última versão (branch main)
  .\update.ps1 -Mock            # idem, em modo demonstração
  .\update.ps1 -Rollback        # volta para a versão anterior

.NOTES
  Executar como Administrador dentro da pasta deploy\windows do clone Git.
  Preserva C:\PortalB1\config (tenants.json, branding) e os logs.
#>
[CmdletBinding()]
param(
  [switch]$Mock,
  [switch]$BehindIIS,
  [switch]$Rollback,
  [int]$Port = 18080,
  [string]$Branch = "main"
)

$ErrorActionPreference = "Continue"
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "Git não encontrado. Instale o Git para Windows e abra um novo PowerShell." }

Push-Location $repo
try {
  $before = (git rev-parse --short HEAD).Trim()
  if ($Rollback) {
    Step "Voltando para a versão anterior"
    git checkout -q "HEAD~1"
  } else {
    Step "Baixando a versão mais recente ($Branch)"
    git fetch -q origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch falhou (verifique acesso ao GitHub)" }
    git checkout -q $Branch
    git reset -q --hard "origin/$Branch"
  }
  $after = (git rev-parse --short HEAD).Trim()
  Write-Host "Versão: $before -> $after"
  git log -1 --pretty=format:"  %h  %s  (%cr)"
  Write-Host ""
} finally { Pop-Location }

Step "Reinstalando o serviço"
$params = @{ Port = $Port }
if ($Mock) { $params.Mock = $true }
if ($BehindIIS) { $params.BehindIIS = $true }
& (Join-Path $PSScriptRoot "install-service.ps1") @params
