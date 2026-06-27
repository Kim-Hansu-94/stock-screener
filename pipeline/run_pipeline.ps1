$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = "$dir\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = "$logDir\pipeline_$(Get-Date -Format 'yyyyMMdd').log"

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 파이프라인 시작" | Out-File -Append -Encoding utf8 $logFile
Push-Location $dir
python -m src.main *>> $logFile
$exitCode = $LASTEXITCODE
Pop-Location
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 파이프라인 종료 (exit=$exitCode)" | Out-File -Append -Encoding utf8 $logFile
