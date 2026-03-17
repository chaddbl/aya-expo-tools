# ◇ AYA Expo Tools

Sistema operacional de exposições AYA Studio.
Roda localmente no media server de cada montagem — **funciona 100% offline**.
Quando há internet, conecta ao Portal AYA para controle e monitoramento remoto.

---

## Filosofia

**Local primeiro.** A expo nunca depende de internet para funcionar.
O `aya-expo-tools` é o sistema primário — roda no media server, guia a montagem, controla os equipamentos.
O Portal AYA é visibilidade e controle remoto — bônus quando há conexão, nunca requisito.

**Conhecimento embutido.** O sistema carrega o saber de como montar uma expo AYA.
Setup wizard guia qualquer membro da equipe passo a passo, sem depender de tutoria do Ihon.

---

## Arquitetura

```
aya-expo-tools (LOCAL — media server)
  │
  ├── /setup          ← wizard de montagem e configuração
  ├── /               ← dashboard de operação (projetores, câmeras, rede)
  │
  ├── Módulos (ativados por config de cada expo)
  │   ├── PJLink      ← controle de projetores
  │   ├── Câmeras     ← RTSP / HTTP snapshot (Intelbras, Hikvision, Dahua)
  │   ├── Rede        ← scan de dispositivos, health check
  │   ├── Áudio       ← soundbar ou interface de áudio
  │   ├── DMX         ← ArtNet / iluminação (quando aplicável)
  │   ├── Smart Plugs ← tomadas inteligentes (NovaDigital, Tuya)
  │   ├── Servidor    ← health do media server (CPU, GPU, temp, Resolume)
  │   └── Scheduler   ← cron liga/desliga automático
  │
  └── Portal Sync (quando internet disponível)
      ├── WebSocket persistente → Portal AYA
      ├── Heartbeat 30s → status de todos os dispositivos
      ├── Snapshots de câmera → visão remota
      └── Comandos recebidos → PJLink, scheduler, diagnóstico

Portal AYA (REMOTO — portal.aya.cx)
  ├── /dashboard/expo         ← todas as expos ativas (Beleza Astral + Farol Viajante...)
  ├── /dashboard/expo/[slug]  ← expo específica: câmeras, projetores, status, comandos
  └── Alertas Telegram        ← Ihon + Minhoso notificados quando algo quebra
```

---

## Contextos suportados

| Tipo | Exemplos | Módulos ativos |
|------|----------|----------------|
| Sala imersiva fixa | Beleza Astral (Farol Santander) | PJLink + câmeras + soundbar + smart plugs |
| Expo mobile | Sombras Milenares POA | PJLink + câmeras + DMX + interface áudio + 4G |
| Itinerante com Starlink | Farol Viajante | PJLink + câmeras + Starlink monitoring |
| Com iluminação DMX | qualquer expo com LEDs | + DMX / ArtNet |
| Multi-servidor | expos com SHOW + BKP | + health de múltiplos servidores |

---

## Tipos de internet

| Tipo | Config |
|------|--------|
| `4g` | modem LTE — padrão na maioria das expos |
| `starlink` | Farol Viajante e expos itinerantes de grande porte |
| `venue` | FIESP e venues que fornecem link próprio |

---

## Setup Rápido

```bash
# Clonar no media server
git clone https://github.com/chaddbl/aya-expo-tools.git
cd aya-expo-tools

# Instalar (ou dar dois cliques em install.bat)
npm install

# Iniciar
npm start
```

Abre `http://localhost:3000` no browser.
Na primeira vez, o wizard de setup é iniciado automaticamente.

---

## Configuração por exposição

Cada exposição tem seu arquivo em `config/`:

```json
{
  "exhibition": {
    "name": "Beleza Astral",
    "venue": "Farol Santander",
    "city": "São Paulo",
    "slug": "beleza-astral"
  },
  "modules": {
    "projectors":   { "enabled": true, "protocol": "pjlink" },
    "cameras":      { "enabled": true, "protocol": "rtsp" },
    "internet":     { "enabled": true, "type": "4g" },
    "audio":        { "enabled": true, "type": "soundbar" },
    "dmx":          { "enabled": false },
    "smartplugs":   { "enabled": true, "protocol": "novadigital" },
    "mediaserver":  { "enabled": true }
  },
  "network": {
    "subnet": "192.168.0.0/24",
    "gateway": "192.168.0.1",
    "mediaServer": "192.168.0.13"
  },
  "projectors": [
    { "id": "proj-1", "name": "Projetor 1", "ip": "192.168.0.20", "model": "NEC NP-PE456USL" }
  ],
  "cameras": [
    { "id": "cam-1", "name": "Câmera 1", "ip": "192.168.0.30", "model": "Intelbras iMD 3C" }
  ],
  "schedule": {
    "enabled": true,
    "powerOn": "09:00",
    "powerOff": "20:00"
  },
  "portal": {
    "url": "https://192.168.15.169:3000",
    "apiKey": ""
  }
}
```

---

## Setup Wizard — fluxo de montagem

```
localhost:3000/setup

① Expo          → seleciona ou cria config (nome, local, tipo)
② Rede          → scan automático, confirma IPs, identifica gateway
③ Projetores    → testa PJLink um a um, confirma modelo e input
④ Câmeras       → verifica RTSP, mostra snapshot de confirmação
⑤ Áudio         → tipo: soundbar / interface; testa conexão
⑥ DMX           → se aplicável: ArtNet, universos, dispositivos
⑦ Smart Plugs   → tomadas inteligentes, confirma controle
⑧ Internet      → tipo: 4G / Starlink / venue; mede latência
⑨ Servidor      → specs do media server, versões de SW instalado
⑩ Checklist     → tudo verde? expo pronta para abrir
```

---

## API

| Método | Endpoint | Ação |
|--------|----------|------|
| GET | `/api/health` | Status geral de todos os módulos |
| GET | `/api/projectors` | Lista projetores e status |
| POST | `/api/projectors/all/on` | Liga todos |
| POST | `/api/projectors/all/off` | Desliga todos |
| POST | `/api/projectors/:id/on` | Liga um projetor |
| POST | `/api/projectors/:id/off` | Desliga um projetor |
| GET | `/api/cameras` | Lista câmeras e status |
| GET | `/api/cameras/:id/snapshot` | JPEG snapshot |
| POST | `/api/network/scan` | Escaneia subnet |
| GET | `/api/schedule` | Status da agenda |
| POST | `/api/schedule` | Atualiza liga/desliga |
| GET | `/api/server/health` | CPU, GPU, RAM, temp, uptime |
| WS | `/ws` | WebSocket — sync com Portal AYA |

---

## Equipamentos compatíveis

**Projetores (PJLink Class 1, porta 4352)**
NEC PE456USL · PE506UL · Epson EB-series · Panasonic PT-series · Christie · Barco

**Câmeras (RTSP + HTTP snapshot)**
Intelbras iMD 3C · VHD series · Hikvision DS-series · Dahua IPC-series

**Áudio**
Soundbars JBL (monitoramento de rede) · Interface de áudio + caixas passivas

**Smart Plugs**
NovaDigital (protocolo a definir) · Tuya-compatible

---

## Roadmap

### v1.0 — atual ✅
- PJLink engine (NEC PE456USL)
- Camera manager (RTSP/HTTP)
- Network scanner
- Scheduler (cron)
- Web GUI com tema AYA

### v2.0 — em desenvolvimento
- [ ] Setup wizard (fluxo guiado de montagem)
- [ ] Config modular por tipo de expo
- [ ] Monitor de saúde do servidor (CPU/GPU/temp/Resolume)
- [ ] Smart plugs NovaDigital
- [ ] WebSocket sync com Portal AYA
- [ ] Comandos remotos via portal

### v3.0 — planejado
- [ ] DMX / ArtNet
- [ ] Monitoramento de tipo de internet (4G, Starlink, venue)
- [ ] Visão computacional (contagem de público, heatmap) via 4090
- [ ] Relatórios de sessão

---

## Usuários

| Pessoa | Papel | Uso principal |
|--------|-------|---------------|
| **Ihon Yadoya** | Produtor Técnico | Montagem, setup, operação remota |
| **Minhoso** | Equipe técnica | Monitoramento durante temporada |
| **Leonardo Curti** | Equipe | Operação e diagnóstico |
| **Felipe** | Direção | Visão remota via portal, insights |

---

## Requisitos

- Node.js 18+
- Windows 10/11 (media server AYA) ou Linux
- Rede local com acesso aos projetores/câmeras
- Internet opcional (para sync com Portal AYA)

---

*◇ AYA Studio · Art & Tech — sistema desenvolvido com Pi · Claude Code*
