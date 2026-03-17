# ◇ AYA Expo Tools

Ferramenta self-contained para controle de exposições AYA Studio.
Roda no media server de cada montagem.

## Features

- **Projetores** — Liga/desliga via PJLink (NEC, Epson, Panasonic, etc.)
- **Câmeras** — Status e snapshots RTSP (Intelbras, Hikvision, Dahua, etc.)
- **Rede** — Scan de dispositivos, health check, internet status
- **Agenda** — Cron automático liga/desliga projetores
- **GUI Web** — Interface no browser, acessível de qualquer dispositivo na rede
- **WebSocket** — Atualizações em tempo real

## Setup Rápido

```bash
# Clonar
git clone https://github.com/chaddbl/aya-expo-tools.git
cd aya-expo-tools

# Instalar (ou dar dois cliques em install.bat)
npm install

# Iniciar
npm start
```

Abre http://localhost:3000 no browser.

## Configuração

Cada exposição tem seu arquivo em `config/`:

```bash
# Usar config específica
npm start -- --config=beleza-astral

# Criar nova
cp config/template.json config/nova-expo.json
# Editar IPs, nomes, etc.
```

### Estrutura do config

```json
{
  "exhibition": {
    "name": "Nome da Exposição",
    "venue": "Local",
    "network": { "subnet": "10.0.1.0/24" }
  },
  "projectors": [
    { "id": "proj-1", "name": "Projetor 1", "ip": "10.0.1.20", "input": "HDMI1" }
  ],
  "cameras": [
    { "id": "cam-1", "name": "Câmera 1", "ip": "10.0.1.30", "user": "admin", "password": "" }
  ],
  "schedule": {
    "enabled": true,
    "powerOn": "09:00",
    "powerOff": "20:00"
  }
}
```

## API

| Método | Endpoint | Ação |
|--------|----------|------|
| GET | `/api/health` | Status geral |
| GET | `/api/projectors` | Lista projetores |
| POST | `/api/projectors/poll` | Atualiza status de todos |
| POST | `/api/projectors/all/on` | Liga todos |
| POST | `/api/projectors/all/off` | Desliga todos |
| POST | `/api/projectors/:id/on` | Liga um |
| POST | `/api/projectors/:id/off` | Desliga um |
| POST | `/api/projectors/:id/input` | Troca input (`{ "input": "HDMI1" }`) |
| GET | `/api/cameras` | Lista câmeras |
| POST | `/api/cameras/check` | Verifica conexão |
| GET | `/api/cameras/:id/snapshot` | JPEG snapshot |
| POST | `/api/network/scan` | Escaneia rede |
| GET | `/api/schedule` | Status da agenda |
| POST | `/api/schedule` | Atualiza agenda |

## Projetores Compatíveis (PJLink)

Qualquer projetor com PJLink Class 1 (porta 4352):
- NEC PE456USL, PE506UL
- Epson EB-series
- Panasonic PT-series
- Christie, Barco, etc.

## Câmeras Compatíveis

Qualquer câmera com RTSP e/ou HTTP snapshot:
- Intelbras iMD 3C, VHD series
- Hikvision DS-series
- Dahua IPC-series

## Requisitos

- Node.js 18+
- Rede local com acesso aos projetores/câmeras

---

◇ AYA Studio · Art & Tech
