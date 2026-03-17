@echo off
echo.
echo   ◇ AYA EXPO TOOLS — Instalação
echo.
echo   Instalando dependências...
echo.
cd /d "%~dp0"
npm install
echo.
echo   ✅ Pronto! Para iniciar:
echo   npm start
echo.
echo   Ou com outra config:
echo   npm start -- --config=nome-da-expo
echo.
pause
