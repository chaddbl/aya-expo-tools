# AYA Expo Tools — Remote Installer
# Roda no media server, baixa do AYA1 via HTTP

param(
    [string]$Source = "http://10.253.0.1:9999",
    [string]$InstallDir = "C:\aya-expo-tools"
)

Write-Host ""
Write-Host "  ◇ AYA EXPO TOOLS — Instalador Remoto" -ForegroundColor White
Write-Host ""

# Criar diretório
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Baixar lista de arquivos
Write-Host "  Conectando a $Source..." -ForegroundColor Gray
try {
    $files = Invoke-RestMethod -Uri "$Source/files.json" -TimeoutSec 10
} catch {
    Write-Host "  ✗ Erro ao conectar: $_" -ForegroundColor Red
    exit 1
}

Write-Host "  Baixando $($files.Count) arquivos..." -ForegroundColor Gray

foreach ($file in $files) {
    $destPath = Join-Path $InstallDir $file.Replace("/", "\")
    $destDir = Split-Path $destPath -Parent
    
    if (!(Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    
    try {
        Invoke-WebRequest -Uri "$Source/$file" -OutFile $destPath -TimeoutSec 30
        Write-Host "    ✓ $file" -ForegroundColor DarkGray
    } catch {
        Write-Host "    ✗ $file - $_" -ForegroundColor Red
    }
}

# Instalar dependências
Write-Host ""
Write-Host "  Instalando dependências npm..." -ForegroundColor Gray
Set-Location $InstallDir
npm install 2>&1 | Out-Null

Write-Host ""
Write-Host "  ✅ Instalado em $InstallDir" -ForegroundColor Green
Write-Host ""
Write-Host "  Para iniciar:" -ForegroundColor White
Write-Host "    cd $InstallDir" -ForegroundColor Cyan
Write-Host "    npm start" -ForegroundColor Cyan
Write-Host ""
