<#
.SYNOPSIS
  Atualiza o Portal B1 a partir do GitHub SEM git e SEM NSSM, e mantem o portal rodando em segundo plano.

.DESCRIPTION
  1. Compara a versao instalada com a ultima do GitHub (branch main). Se for a mesma, so garante que o portal esta no ar.
  2. Baixa o pacote, faz backup completo (C:\PortalB1-backups\<data>), copia por cima preservando
     config (tenants.json, branding.json, reports.json, settings, secret.key, brand), data e logs.
  3. Roda "npm ci" so quando as dependencias mudaram.
  4. Roda o portal como Tarefa Agendada "PortalB1" (conta SYSTEM, sobe com o Windows, reinicia se cair).
  5. Testa /api/health. Se nao responder, volta o backup automaticamente.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\PortalB1\atualizar.ps1
  ... -Forcar                         reinstala mesmo sem versao nova
  ... -AgendarAtualizacao -Hora 03:00 atualiza sozinho todo dia nesse horario
  ... -CriarAtalho                    cria "Atualizar Portal B1" na Area de Trabalho
  ... -Rollback                       volta para o ultimo backup

.NOTES
  Executar como Administrador. Log: C:\PortalB1\logs\atualizacao.log
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\PortalB1",
  [string]$Branch = "main",
  [string]$Repo = "vagnerrodrigues/PortalB1_Fiori",
  [int]$Port = 18080,
  [string]$TaskName = "PortalB1",
  [switch]$Mock,
  [switch]$Forcar,
  [switch]$AgendarAtualizacao,
  [string]$Hora = "03:00",
  [switch]$CriarAtalho,
  [switch]$Rollback
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest muito mais rapido sem barra de progresso

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Execute como Administrador (botao direito > Executar como administrador)." -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "logs") | Out-Null
$logFile = Join-Path $InstallDir "logs\atualizacao.log"
function Log($msg, $color = "Gray") {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

$backupRoot = "$InstallDir-backups"
$versionFile = Join-Path $InstallDir "VERSION"
$self = Join-Path $InstallDir "atualizar.ps1"

# ---------------------------------------------------------------------------
function Stop-Portal {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  # node do portal (tarefa, janela do PowerShell ou servico antigo): identifica pela linha de comando
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'server[\\/]index\.js' } | ForEach-Object {
    Log "Encerrando portal em execucao (PID $($_.ProcessId))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Ensure-Task {
  $startCmd = Join-Path $InstallDir "start.cmd"
  $mockLine = if ($Mock) { "set MOCK=1" } else { "set MOCK=" }
  # Laco: se o node cair, volta em 5 s. Saida em logs\portal.out.log
  @(
    "@echo off",
    "cd /d `"$InstallDir`"",
    "set PORT=$Port",
    $mockLine,
    ":loop",
    "node server\index.js >> logs\portal.out.log 2>&1",
    "timeout /t 5 /nobreak >nul",
    "goto loop"
  ) | Set-Content -Path $startCmd -Encoding ASCII

  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$startCmd`"" -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Start-Portal {
  Ensure-Task
  Start-ScheduledTask -TaskName $TaskName
}

function Test-Portal {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
      if ($h.ok) { return $h }
    } catch {}
  }
  return $null
}

function Copy-Tree($from, $to) {
  # /XD e /XF com caminho completo: so os arquivos/pastas do cliente ficam de fora
  $xd = @((Join-Path $from "node_modules"), (Join-Path $from "data"), (Join-Path $from "logs"), (Join-Path $from "config\settings"), (Join-Path $from "config\brand"))
  $xf = @("tenants.json", "branding.json", "reports.json", "secret.key", "VERSION", "start.cmd")
  & robocopy $from $to /E /XD $xd /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar arquivos (robocopy $LASTEXITCODE)" }
}

function Backup-Now {
  $dest = Join-Path $backupRoot (Get-Date -Format "yyyyMMdd-HHmmss")
  & robocopy $InstallDir $dest /E /XD (Join-Path $InstallDir "node_modules") /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha no backup (robocopy $LASTEXITCODE)" }
  # mantem os 5 backups mais recentes
  Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  return $dest
}

function Restore-Backup($dir) {
  Log "Restaurando backup $dir" "Yellow"
  Stop-Portal
  & robocopy $dir $InstallDir /E /XD (Join-Path $dir "node_modules") /NFL /NDL /NJH /NJS /NP | Out-Null
  Start-Portal
}

# ---------------------------------------------------------------------------
Log "===== Atualizacao do Portal B1 ($Branch) =====" "Cyan"

if ($Rollback) {
  $last = Get-ChildItem $backupRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $last) { Log "Nenhum backup encontrado em $backupRoot" "Red"; exit 1 }
  Restore-Backup $last.FullName
  if (Test-Portal) { Log "Portal de volta na versao do backup $($last.Name)" "Green"; exit 0 }
  Log "Portal nao respondeu apos o rollback. Veja logs\portal.out.log" "Red"; exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Log "Node.js nao encontrado no PATH." "Red"; exit 1 }
if (-not (Test-Path (Join-Path $InstallDir "config\tenants.json"))) { Log "Nao achei $InstallDir\config\tenants.json. Instale o portal primeiro." "Red"; exit 1 }

# 1. Versao nova?
$installed = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { "" }
$latest = $null
try {
  $latest = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/commits/$Branch" -Headers @{ "User-Agent" = "PortalB1-Updater" } -TimeoutSec 20).sha
} catch { Log "Nao consegui consultar a versao no GitHub ($($_.Exception.Message)). Seguindo com o download." "Yellow" }

$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'server[\\/]index\.js' }
if ($latest -and $latest -eq $installed -and -not $Forcar) {
  Log "Ja esta na versao mais recente ($($latest.Substring(0,7)))." "Green"
  if (-not $running -or -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Log "Garantindo o portal em segundo plano..."; Stop-Portal; Start-Portal; if (Test-Portal) { Log "Portal no ar em http://localhost:$Port" "Green" } }
} else {
  # 2. Download
  $tmp = Join-Path $env:TEMP "portalb1-update"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "portal.zip"
  Log "Baixando $Repo ($Branch)..."
  Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (-not $src -or -not (Test-Path (Join-Path $src.FullName "server\index.js"))) { Log "Pacote baixado invalido." "Red"; exit 1 }

  # 3. Backup + copia
  $bk = Backup-Now
  Log "Backup em $bk"
  $oldLock = if (Test-Path (Join-Path $InstallDir "package-lock.json")) { (Get-FileHash (Join-Path $InstallDir "package-lock.json")).Hash } else { "" }
  Stop-Portal
  try {
    Copy-Tree $src.FullName $InstallDir
    $newLock = (Get-FileHash (Join-Path $InstallDir "package-lock.json")).Hash
    if ($newLock -ne $oldLock -or -not (Test-Path (Join-Path $InstallDir "node_modules\express"))) {
      Log "Dependencias mudaram: npm ci..."
      Push-Location $InstallDir
      try { & cmd /c "npm ci --omit=dev --no-audit --no-fund" | Out-Null } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { throw "npm ci falhou ($LASTEXITCODE)" }
    }
    # o proprio atualizador tambem se atualiza
    Copy-Item (Join-Path $src.FullName "deploy\windows\atualizar.ps1") $self -Force
    if ($latest) { Set-Content -Path $versionFile -Value $latest -Encoding ASCII }

    # 4. Sobe e testa
    Start-Portal
    $h = Test-Portal
    if (-not $h) { throw "Portal nao respondeu em /api/health apos a atualizacao" }
    Log ("Atualizado para {0}. Portal no ar em http://localhost:{1} ({2}; modulos: {3})" -f $(if ($latest) { $latest.Substring(0,7) } else { "?" }), $Port, $h.mode, ($h.modules -join ", ")) "Green"
  } catch {
    Log "ERRO: $($_.Exception.Message)" "Red"
    Restore-Backup $bk
    if (Test-Portal) { Log "Versao anterior restaurada e no ar." "Yellow" } else { Log "Versao anterior restaurada, mas nao respondeu. Veja logs\portal.out.log" "Red" }
    exit 1
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 5. Opcionais
if ($AgendarAtualizacao) {
  if ($Hora -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { Log "Hora invalida: $Hora (use HH:MM)" "Red"; exit 1 }
  $args2 = "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -InstallDir `"$InstallDir`" -Port $Port" + $(if ($Mock) { " -Mock" } else { "" })
  $a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $args2
  $t = New-ScheduledTaskTrigger -Daily -At $Hora
  $p = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName "$TaskName-Atualizacao" -Action $a -Trigger $t -Principal $p -Force | Out-Null
  Log "Atualizacao automatica agendada todo dia as $Hora (tarefa $TaskName-Atualizacao)." "Green"
}

if ($CriarAtalho) {
  $lnk = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "Atualizar Portal B1.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = "powershell.exe"
  $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$self`" -InstallDir `"$InstallDir`" -Port $Port" + $(if ($Mock) { " -Mock" } else { "" })
  $sc.WorkingDirectory = $InstallDir
  $sc.IconLocation = "shell32.dll,238"
  $sc.Save()
  # marca "Executar como administrador" no atalho
  $bytes = [IO.File]::ReadAllBytes($lnk); $bytes[0x15] = $bytes[0x15] -bor 0x20; [IO.File]::WriteAllBytes($lnk, $bytes)
  Log "Atalho criado na Area de Trabalho: 'Atualizar Portal B1'." "Green"
}
