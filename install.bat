@echo off
setlocal enabledelayedexpansion
title AYA Expo Tools — Instalador
color 0F

echo.
echo   ^<^> AYA EXPO TOOLS
echo   Instalador v1.0
echo   aya.studio
echo.
echo ============================================================
echo.

:: ─── Admin check ─────────────────────────────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo   [!] Execute como Administrador.
  echo       Clique direito no arquivo ^> Executar como administrador
  echo.
  pause
  exit /b 1
)

set INSTALL_DIR=C:\aya-expo-tools
set REPO_URL=https://github.com/chaddbl/aya-expo-tools
set REPO_ZIP=https://github.com/chaddbl/aya-expo-tools/archive/refs/heads/master.zip
set NODE_URL=https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi
set RUSTDESK_URL=https://github.com/rustdesk/rustdesk/releases/download/1.3.8/rustdesk-1.3.8-x86_64.exe
set TEMP_DIR=%TEMP%\aya-expo-install

:: ─── Step 1: Node.js ─────────────────────────────────────────
echo   [1/5] Verificando Node.js...
where node >nul 2>&1
if %errorLevel% equ 0 (
  for /f "tokens=*" %%v in ('node --version') do echo         Node.js %%v ja instalado. OK.
) else (
  echo         Node.js nao encontrado. Instalando...
  echo         Isso pode demorar alguns minutos...

  :: Try winget first (Windows 10/11)
  where winget >nul 2>&1
  if %errorLevel% equ 0 (
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  ) else (
    :: Fallback: download MSI
    mkdir "%TEMP_DIR%" >nul 2>&1
    echo         Baixando Node.js...
    curl -L -o "%TEMP_DIR%\node.msi" "%NODE_URL%" --progress-bar
    echo         Instalando Node.js...
    msiexec /i "%TEMP_DIR%\node.msi" /quiet /norestart
  )

  :: Reload PATH
  for /f "tokens=*" %%p in ('powershell -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\")"') do set PATH=%%p;%PATH%

  where node >nul 2>&1
  if %errorLevel% neq 0 (
    echo.
    echo   [!] Falha ao instalar Node.js.
    echo       Instale manualmente: https://nodejs.org
    pause
    exit /b 1
  )
  echo         Node.js instalado com sucesso.
)

:: ─── Step 2: Instalar/atualizar aya-expo-tools ────────────────
echo.
echo   [2/5] Instalando AYA Expo Tools...

if exist "%INSTALL_DIR%\.git" (
  echo         Atualizando instalacao existente...
  cd /d "%INSTALL_DIR%"
  git pull origin master
) else if exist "%INSTALL_DIR%" (
  :: Existe mas nao e git repo — baixar ZIP e extrair por cima
  echo         Atualizando arquivos...
  mkdir "%TEMP_DIR%" >nul 2>&1
  curl -L -o "%TEMP_DIR%\aya-expo-tools.zip" "%REPO_ZIP%" --progress-bar
  powershell -Command "Expand-Archive -Path '%TEMP_DIR%\aya-expo-tools.zip' -DestinationPath '%TEMP_DIR%\extracted' -Force"
  xcopy /E /Y /I "%TEMP_DIR%\extracted\aya-expo-tools-master" "%INSTALL_DIR%" >nul
) else (
  :: Instalacao nova
  echo         Baixando AYA Expo Tools...
  where git >nul 2>&1
  if %errorLevel% equ 0 (
    git clone "%REPO_URL%" "%INSTALL_DIR%"
  ) else (
    mkdir "%TEMP_DIR%" >nul 2>&1
    curl -L -o "%TEMP_DIR%\aya-expo-tools.zip" "%REPO_ZIP%" --progress-bar
    powershell -Command "Expand-Archive -Path '%TEMP_DIR%\aya-expo-tools.zip' -DestinationPath '%TEMP_DIR%\extracted' -Force"
    mkdir "%INSTALL_DIR%" >nul 2>&1
    xcopy /E /Y /I "%TEMP_DIR%\extracted\aya-expo-tools-master" "%INSTALL_DIR%" >nul
  )
)

echo         Instalando dependencias Node...
cd /d "%INSTALL_DIR%"
call npm install --silent
if %errorLevel% neq 0 (
  echo   [!] Erro ao instalar dependencias.
  pause
  exit /b 1
)
echo         Dependencias instaladas. OK.

:: ─── Step 3: RustDesk ────────────────────────────────────────
echo.
echo   [3/5] Verificando RustDesk...
tasklist /FI "IMAGENAME eq rustdesk.exe" 2>nul | find /I "rustdesk.exe" >nul
if %errorLevel% equ 0 (
  echo         RustDesk ja esta rodando. OK.
) else (
  where rustdesk >nul 2>&1
  if %errorLevel% equ 0 (
    echo         RustDesk instalado. Iniciando...
    start "" rustdesk
  ) else (
    echo         RustDesk nao encontrado. Baixando...
    mkdir "%TEMP_DIR%" >nul 2>&1
    curl -L -o "%TEMP_DIR%\rustdesk.exe" "%RUSTDESK_URL%" --progress-bar
    echo         Instalando RustDesk...
    "%TEMP_DIR%\rustdesk.exe" --silent-install >nul 2>&1
    timeout /t 3 /nobreak >nul
    echo         RustDesk instalado. OK.
  )
)

:: ─── Step 4: Auto-start ──────────────────────────────────────
echo.
echo   [4/5] Configurando inicializacao automatica...

set START_SCRIPT=%INSTALL_DIR%\start.bat
echo @echo off > "%START_SCRIPT%"
echo cd /d "%INSTALL_DIR%" >> "%START_SCRIPT%"
echo start "" http://localhost:3000 >> "%START_SCRIPT%"
echo node server/index.js >> "%START_SCRIPT%"

:: Task Scheduler — inicia com o Windows, sem login necessario
schtasks /query /tn "AYA Expo Tools" >nul 2>&1
if %errorLevel% neq 0 (
  schtasks /create /tn "AYA Expo Tools" /tr "%START_SCRIPT%" /sc onstart /ru SYSTEM /rl HIGHEST /f >nul
  echo         Task Scheduler configurado. Inicia automaticamente no boot.
) else (
  schtasks /change /tn "AYA Expo Tools" /tr "%START_SCRIPT%" >nul
  echo         Task Scheduler atualizado.
)

:: ─── Step 5: Atalho na area de trabalho ──────────────────────
echo.
echo   [5/5] Criando atalho na area de trabalho...

set SHORTCUT=%PUBLIC%\Desktop\AYA Expo Tools.lnk
powershell -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%'); $s.TargetPath='%START_SCRIPT%'; $s.WorkingDirectory='%INSTALL_DIR%'; $s.Description='AYA Expo Tools'; $s.Save()"
echo         Atalho criado na area de trabalho.

:: ─── Iniciar agora ───────────────────────────────────────────
echo.
echo ============================================================
echo.
echo   Instalacao concluida!
echo.
echo   Iniciando AYA Expo Tools...
echo   Abrindo http://localhost:3000
echo.
echo ============================================================
echo.

start "" http://localhost:3000
timeout /t 2 /nobreak >nul
start "" "%START_SCRIPT%"

:: Limpar temporarios
if exist "%TEMP_DIR%" rmdir /S /Q "%TEMP_DIR%" >nul 2>&1

echo   Pronto. O browser vai abrir em alguns segundos.
echo   Pressione qualquer tecla para fechar esta janela.
pause >nul
