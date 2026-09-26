# Remove o serviço do Portal B1 (não apaga arquivos nem logs).
param(
  [string]$ServiceName = "PortalB1",
  [string]$NssmPath    = (Join-Path $PSScriptRoot "nssm.exe")
)
$ErrorActionPreference = "Stop"
& $NssmPath stop $ServiceName
& $NssmPath remove $ServiceName confirm
Write-Host "Serviço $ServiceName removido."
