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
echo   [1/8] Verificando Node.js...
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
echo   [2/8] Instalando AYA Expo Tools...

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

:: ─── Step 3: FFmpeg (video loop generation) ──────────────────
echo.
echo   [3/7] Verificando FFmpeg para loop de video...

set FFMPEG_DIR=C:\ffmpeg
set FFMPEG_ZIP_URL=https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip

if exist "%FFMPEG_DIR%\ffmpeg.exe" (
  echo         FFmpeg ja instalado. OK.
) else (
  echo         FFmpeg nao encontrado. Baixando...
  mkdir "%FFMPEG_DIR%" >nul 2>&1
  mkdir "%TEMP_DIR%" >nul 2>&1
  curl -L -o "%TEMP_DIR%\ffmpeg.zip" "%FFMPEG_ZIP_URL%" --progress-bar
  echo         Extraindo...
  powershell -Command "Expand-Archive -Path '%TEMP_DIR%\ffmpeg.zip' -DestinationPath '%TEMP_DIR%\ffmpeg-extract' -Force"
  :: Find and copy binaries (nested folder with version in name)
  for /d %%i in ("%TEMP_DIR%\ffmpeg-extract\ffmpeg-*") do (
    copy "%%i\bin\ffmpeg.exe" "%FFMPEG_DIR%\ffmpeg.exe" >nul
    copy "%%i\bin\ffprobe.exe" "%FFMPEG_DIR%\ffprobe.exe" >nul
  )
  :: Cleanup
  rmdir /s /q "%TEMP_DIR%\ffmpeg-extract" 2>nul
  del "%TEMP_DIR%\ffmpeg.zip" 2>nul

  if exist "%FFMPEG_DIR%\ffmpeg.exe" (
    echo         FFmpeg instalado em %FFMPEG_DIR%. OK.
  ) else (
    echo   [!] Falha ao instalar FFmpeg.
    echo       Baixe manualmente: https://www.gyan.dev/ffmpeg/builds/
    echo       Extraia ffmpeg.exe e ffprobe.exe em C:\ffmpeg\
  )
)

:: ─── Step 4: Python + Computer Vision ────────────────────────
echo.
echo   [4/8] Verificando Python para Computer Vision...

set PYTHON_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe
set CV_DIR=%INSTALL_DIR%\cv
set VENV_DIR=%CV_DIR%\venv

where python >nul 2>&1
if %errorLevel% equ 0 (
  for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo         %%v ja instalado.
  goto :python_ok
)

echo         Python nao encontrado. Instalando...
where winget >nul 2>&1
if %errorLevel% equ 0 (
  winget install Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
) else (
  mkdir "%TEMP_DIR%" >nul 2>&1
  echo         Baixando Python 3.11...
  curl -L -o "%TEMP_DIR%\python-installer.exe" "%PYTHON_URL%" --progress-bar
  echo         Instalando Python...
  "%TEMP_DIR%\python-installer.exe" /quiet InstallAllUsers=1 PrependPath=1 Include_pip=1
)

:: Reload PATH
for /f "tokens=*" %%p in ('powershell -Command "[System.Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\")"') do set PATH=%%p;%PATH%

where python >nul 2>&1
if %errorLevel% neq 0 (
  echo   [!] Falha ao instalar Python. CV nao estara disponivel.
  echo       Instale manualmente: https://www.python.org/downloads/
  goto :skip_cv
)
echo         Python instalado com sucesso.

:python_ok
:: Verifica se tem GPU NVIDIA (para CUDA)
echo.
echo   [4b/8] Configurando ambiente CV...
where nvidia-smi >nul 2>&1
if %errorLevel% equ 0 (
  echo         GPU NVIDIA detectada. Instalando PyTorch com CUDA...
  set TORCH_INDEX=--extra-index-url https://download.pytorch.org/whl/cu121
) else (
  echo         GPU NVIDIA nao detectada. Instalando PyTorch CPU...
  set TORCH_INDEX=
)

:: Criar venv se nao existe
if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo         Criando ambiente virtual Python...
  python -m venv "%VENV_DIR%"
)

:: Instalar dependencias
echo         Instalando dependencias CV (PyTorch + YOLO + OpenCV)...
echo         Isso pode demorar 5-10 minutos na primeira vez...
"%VENV_DIR%\Scripts\pip.exe" install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cu121
"%VENV_DIR%\Scripts\pip.exe" install --quiet -r "%CV_DIR%\requirements.txt"

if %errorLevel% neq 0 (
  echo   [!] Erro ao instalar dependencias CV.
  goto :skip_cv
)

:: Download YOLO model (yolov8n — 6MB, muito rapido)
echo         Baixando modelo YOLO...
"%VENV_DIR%\Scripts\python.exe" -c "from ultralytics import YOLO; YOLO('yolov8n')" 2>nul
echo         Modelo YOLOv8-nano pronto.
echo         Computer Vision configurado. OK.

:skip_cv

:: ─── Step 4: RustDesk ────────────────────────────────────────
echo.
echo   [5/8] Verificando RustDesk...
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

:: ─── Step 5: Auto-start ──────────────────────────────────────
echo.
echo   [6/8] Configurando inicializacao automatica...

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

:: ─── Step 6: Atalho na area de trabalho ──────────────────────
echo.
echo   [7/8] Criando atalho na area de trabalho...

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
