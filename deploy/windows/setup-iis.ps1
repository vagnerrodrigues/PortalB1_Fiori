<#
.SYNOPSIS
  Cria o site HTTPS no IIS como proxy reverso para o serviço do portal (Node em 127.0.0.1).

.EXAMPLE
  .\setup-iis.ps1 -HostName portal.cliente.com.br -CertThumbprint "AB12...EF"

.NOTES
  Pré-requisitos (instalar antes):
   - IIS com a feature Web-Server
   - URL Rewrite 2.1:            https://www.iis.net/downloads/microsoft/url-rewrite
   - Application Request Routing: https://www.iis.net/downloads/microsoft/application-request-routing
   - Certificado SSL importado em Cert:\LocalMachine\My
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$HostName,
  [Parameter(Mandatory)] [string]$CertThumbprint,
  [string]$SiteName = "PortalB1",
  [string]$SitePath = "C:\inetpub\PortalB1",
  [int]   $Port     = 18080
)

$ErrorActionPreference = "Stop"
$appcmd = Join-Path $env:windir "system32\inetsrv\appcmd.exe"
if (-not (Test-Path $appcmd)) { throw "IIS não encontrado. Instale: Install-WindowsFeature Web-Server -IncludeManagementTools" }
Import-Module WebAdministration

# ARR: habilitar proxy e preservar host
& $appcmd set config -section:system.webServer/proxy /enabled:"True" /preserveHostHeader:"True" /reverseRewriteHostInResponseHeaders:"False" /commit:apphost | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Falha ao habilitar proxy. O Application Request Routing está instalado?" }

# Permitir a variável X-Forwarded-Proto na regra de rewrite
$allowed = & $appcmd list config -section:system.webServer/rewrite/allowedServerVariables
if ($allowed -notmatch "HTTP_X_FORWARDED_PROTO") {
  & $appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_PROTO']" /commit:apphost | Out-Null
}

# Pasta do site com o web.config de proxy
New-Item -ItemType Directory -Force -Path $SitePath | Out-Null
(Get-Content (Join-Path $PSScriptRoot "web.config") -Raw).Replace("127.0.0.1:18080", "127.0.0.1:$Port") |
  Set-Content -Path (Join-Path $SitePath "web.config") -Encoding UTF8

# Site HTTPS
if (Get-Website -Name $SiteName -ErrorAction SilentlyContinue) { Remove-Website -Name $SiteName }
New-Website -Name $SiteName -PhysicalPath $SitePath -HostHeader $HostName -Port 443 -Ssl -SslFlags 1 | Out-Null
$binding = Get-WebBinding -Name $SiteName -Protocol https
$binding.AddSslCertificate($CertThumbprint, "My")

# Redirecionar HTTP -> HTTPS
New-WebBinding -Name $SiteName -Protocol http -Port 80 -HostHeader $HostName

Write-Host "OK: https://$HostName -> http://127.0.0.1:$Port" -ForegroundColor Green
