# AYA Expo Tools — Estratégia Completa

> Documento canônico. Auditoria inicial: 2026-03-18 (Casey Reas + Case Mori).
> Atualizar aqui antes de implementar qualquer ciclo.

---

## 1. Visão

O aya-expo-tools é um sistema em duas camadas para controle e presença em exposições AYA:

- **Camada Local** — roda no media server da expo, 100% offline, é o sistema primário
- **Camada Remota** — roda no Portal AYA (portal.aya.cx), requer internet, é visibilidade + controle

**Princípio fundacional:** a expo nunca depende do portal para funcionar.

---

## 2. Estado Atual (v1.x — em campo)

**Deploy:** Media server Beleza Astral (Farol Santander SP)
- Acesso: `10.253.0.11` via WireGuard / `192.168.0.13` na rede local
- Internet: 4G

**O que funciona:**
- Dashboard local com 4 páginas (index, config, commissioning, verificação)
- PJLink engine (6 projetores NEC PE456USL)
- Camera manager (4x Intelbras iMD 3C Black, cam-4 pendente)
- Network scanner (subnet discovery, MAC lookup)
- Scheduler (liga/desliga automático, desativado — Chataigne controla)
- TVs Hisense (WOL + MQTT)
- Smart plugs NovaDigital
- Config como canvas espacial (planta + dispositivos arrastáveis)
- Design system consolidado (shared.css)
- WebSocket local para updates em tempo real

**O que falta (campo):**
- cam-4 não conectada fisicamente
- IPs dos projetores ainda placeholder (192.168.0.20–25)
- Verificação de Sistemas não rodou com dispositivos reais
- MJPEG no browser não validado visualmente

---

## 3. Auditoria de Integração Portal ↔ Expo Tools

### 3.1 Casey Reas — Leitura de Linguagem

**Tensão central:** O plano original tratava a expo como _dado a ser consumido_ pelo portal (tabela de estados, botões liga/desliga). Mas uma exposição é um _ambiente espacial com comportamento temporal_ — tem planta, zonas, público, ciclo diário.

**Diagnóstico:**
- O wireframe do doc de arquitetura (`P1 ● P2 ● ... [Ligar Todos]`) é um painel de controle industrial
- Não há diferença formal entre monitorar projetores numa sala imersiva e servidores num rack
- O medium desapareceu

**O que falta de linguagem:**

| Dimensão | No expo-tools local | No portal (planejado) | Gap |
|----------|---------------------|----------------------|-----|
| Espacialidade | Canvas com planta + dispositivos | Tabela de estados | Planta desaparece |
| Temporalidade | Scheduler, ciclo liga/desliga | Heartbeat 30s | Sessões/dias, não pulsos |
| Comportamento | Eventos (projetor caiu, câmera offline) | Polling de estado | Transições invisíveis |
| Presença | Câmeras MJPEG ao vivo | Snapshots 5s | Vigiar ≠ estar lá |

**Direção proposta:**

> Não replicar o dashboard local no portal. Criar uma experiência de **presença remota**.

O expo-tools local é o cockpit do técnico (Ihon, Minhoso) — botões, estados, controle individual.
O portal é a janela do Felipe — precisa mostrar:

1. **A expo está viva?** (sim/não, profundidade on-demand)
2. **O que aconteceu hoje?** (timeline: abriu, fechou, projetor caiu, recuperou)
3. **Como está agora?** (mosaico de câmeras + sinais vitais)
4. **Posso agir?** (ligar/desligar tudo — não controle granular)

**Perguntas canônicas Casey que guiam:**
- O sistema mostra estados ou processos? → processos (timeline de eventos)
- A forma nasce do comportamento? → sim, se o layout responder ao estado da expo
- Existe gramática clara? → poucos elementos: expo viva/morta, timeline, câmeras, vitais
- Onde o sistema respira? → no mosaico de câmeras — é a presença, não o controle

### 3.2 Case Mori — Mapa de Falhas

**Parecer: APROVADO COM RESSALVAS**

A arquitetura é sólida no princípio (local-first, outbound WS, NAT-friendly).

**Diagrama de dependências:**
```
Media Server (campo, rede do venue)
  └── WebSocket outbound ────→ Portal AYA (Unraid, rede AYA)
       ├── Depende de: internet no venue (4G)
       ├── Depende de: portal online (Docker Unraid)
       ├── Depende de: auth (BOT_API_KEY)
       └── Bidirecional: comandos PJLink voltam pelo WS
```

**SPOFs aceitáveis:** 4G cai → portal perde visibilidade, expo continua. ✅
**SPOF perigoso:** comando remoto durante sessão com público → projetores desligam → público no escuro. ❌

**Ressalvas obrigatórias:**

| # | Ressalva | Prioridade | Quando resolver |
|---|----------|-----------|-----------------|
| R1 | Reconnect com backoff exponencial no WS client | P0 | Ciclo 2 (antes de ir pra produção) |
| R2 | Ack explícito de comandos (enviado → confirmado → falhou) | P0 | Ciclo 3 |
| R3 | Circuit breaker no WS client (max retries, then stop) | P1 | Ciclo 2 |
| R4 | Modo "sessão ativa" que rejeita comandos destrutivos remotos | P1 | Ciclo 3 |
| R5 | Alertas Telegram (expo offline, projetor caiu em sessão) | P1 | Ciclo 3 |
| R6 | Audit log de comandos remotos (who, when, what) | P2 | Ciclo 3 |

**Cenário de risco mitigado pela estratégia de ciclos:**
O Ciclo 1 (presença) não envia comandos → elimina R2, R4, R6 do MVP.
O Ciclo 2 (sync bidirecional) adiciona WS → precisa de R1, R3.
O Ciclo 3 (controle remoto) adiciona comandos → precisa de R2, R4, R5, R6.

---

## 4. Estratégia de Implementação — 4 Ciclos

### Ciclo 1 — PRESENÇA (experimento mínimo)
> "Se essa página mudar a forma como Felipe percebe a expo, a linguagem está certa."

**Escopo:**
- Página `/dashboard/expo` no Portal AYA
- Fetch periódico (30s) no `/api/health` do expo-tools via proxy no portal
- Proxy de snapshots de câmera via portal (resolve mixed content HTTPS→HTTP)
- Sem WebSocket. Sem banco. Sem controle remoto.

**O que aparece na tela:**

```
┌─────────────────────────────────────────────────────────────┐
│  BELEZA ASTRAL · Farol Santander · São Paulo                │
│  ● Online · há 12s                              [Detalhes]  │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  cam-1   │ │  cam-2   │ │  cam-3   │ │  cam-4   │       │
│  │  [snap]  │ │  [snap]  │ │  [snap]  │ │ offline  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│                                                              │
│  Projetores: 6/6 ✓   Câmeras: 3/4 ✓   Internet: 4G ✓      │
│  Scheduler: off       Uptime: 4h 23m                        │
│                                                              │
│  ── Hoje ──────────────────────────────────────────          │
│  09:02  Sistema iniciado                                     │
│  09:03  6/6 projetores ligados                               │
│  09:05  Câmeras 1-3 online                                   │
│  14:12  cam-2 offline (reconectou 14:13)                     │
└─────────────────────────────────────────────────────────────┘
```

**Implementação:**

| Componente | Onde | O que faz |
|-----------|------|-----------|
| Proxy API | `portal: /api/expo/[slug]/health` | GET → fetch `http://<expo-ip>:3000/api/health` via WireGuard |
| Proxy câmera | `portal: /api/expo/[slug]/camera/[camId]` | GET → fetch snapshot JPEG do expo-tools, retorna como image |
| Proxy projetores | `portal: /api/expo/[slug]/projectors` | GET → fetch `/api/projectors` do expo-tools |
| Config de expos | `portal: lib/expo-config.ts` | Mapa estático: slug → IP + nome + venue (sem banco por agora) |
| Log endpoint | `expo-tools: /api/log` | Já existe — eventos com timestamp |
| Proxy log | `portal: /api/expo/[slug]/log` | GET → fetch `/api/log` do expo-tools |
| Página | `portal: /dashboard/expo/page.tsx` | Lista de expos ativas com status |
| Página detail | `portal: /dashboard/expo/[slug]/page.tsx` | Câmeras + vitais + timeline |
| Nav entry | `portal: lib/nav.ts` | "Exposições" no grupo trabalho |

**Exit criteria:**
- [ ] Página renderiza com dados reais do Beleza Astral
- [ ] Mosaico de câmeras mostra snapshots atualizados
- [ ] Timeline mostra eventos do dia
- [ ] Felipe percebe a expo remotamente de forma útil

**Estimativa:** ~3h

---

### Ciclo 2 — SYNC BIDIRECIONAL (WebSocket)
> Substitui polling por canal persistente. Habilita updates em tempo real.

**Escopo:**
- WebSocket client no expo-tools (`server/portal-sync.js`)
- WebSocket server no portal (`/api/expo/ws`)
- Heartbeat 30s com status completo
- Snapshots de câmera via WS (base64 JPEG, 1 cam por heartbeat em rodízio)
- Reconnect com backoff exponencial (R1)
- Circuit breaker: max 10 retries em 5min, depois desiste por 30min (R3)

**Não inclui:**
- Comandos remotos (Ciclo 3)
- Alertas Telegram (Ciclo 3)

**Exit criteria:**
- [ ] WS conecta e mantém conexão por >1h sem queda
- [ ] Reconecta automaticamente após queda de 4G simulada
- [ ] Circuit breaker ativa após falhas repetidas
- [ ] Portal mostra dados em tempo real via WS

**Estimativa:** ~4h

---

### Ciclo 3 — CONTROLE REMOTO (comandos + proteções)
> Felipe e equipe podem agir na expo via portal.

**Escopo:**
- Comandos via WS: `power-on-all`, `power-off-all`, `projector-on/off`
- Ack explícito de comandos com feedback visual (R2)
- Modo "sessão ativa" no expo-tools (R4):
  - Ihon abre/fecha sessão localmente
  - Sessão ativa → comandos destrutivos remotos são rejeitados
  - Sessão inativa → controle remoto liberado
- Alertas Telegram (R5): expo offline >5min, projetor caiu em sessão
- Audit log de comandos remotos (R6): who, when, what, result

**Exit criteria:**
- [ ] Ligar/desligar funciona via portal
- [ ] Comando durante sessão ativa é rejeitado com mensagem clara
- [ ] Alerta Telegram chega quando projetor cai
- [ ] Audit log registra todos os comandos

**Estimativa:** ~6h

---

### Ciclo 4 — MULTI-EXPO + INTELIGÊNCIA
> Escala para múltiplas expos simultâneas.

**Escopo:**
- Suporte a N expos simultâneas no portal
- Cada expo com seu WS independente
- Comparação entre expos (uptime, incidentes)
- Heatmap de público via câmeras (CV na 4090 — futuro)
- Relatórios de sessão (duração, incidentes, tempo médio de recuperação)

**Não tem estimativa — depende de demanda real.**

---

## 5. Registro de Expos (sem Prisma por agora)

Para o Ciclo 1, configuração estática em `lib/expo-config.ts`:

```typescript
export const EXPOS = [
  {
    slug: 'beleza-astral',
    name: 'Beleza Astral',
    venue: 'Farol Santander',
    city: 'São Paulo',
    ip: '10.253.0.11',       // WireGuard
    localIp: '192.168.0.13', // rede da sala
    port: 3000,
    cameras: ['cam-1', 'cam-2', 'cam-3', 'cam-4'],
    projetoId: null,          // link futuro com Projeto no Portal
  },
] as const
```

Migração para Prisma (`model Expo`) quando houver >1 expo ou necessidade de persistir histórico.

---

## 6. Decisões de Design (influência Casey Reas)

1. **Presença, não controle** — o portal é janela, não cockpit
2. **Eventos, não estados** — timeline mostra transições, não polling
3. **Câmeras como presença** — mosaico atualizado = estar lá
4. **Poucos sinais fortes** — online/offline, contagem OK/falha, timeline
5. **Espaço para respirar** — a página não precisa estar cheia de widgets
6. **Local-first absoluto** — portal é secundário, expo nunca depende dele
7. **Medium, não admin** — a página de expo deve parecer uma exposição monitorada, não um painel SaaS

---

## 7. Proteções de Segurança (Case Mori)

| Proteção | Ciclo | Status |
|----------|-------|--------|
| Local-first (expo funciona sem portal) | Arquitetura | ✅ Garantido |
| Reconnect com backoff exponencial | 2 | ⬜ Pendente |
| Circuit breaker (max retries) | 2 | ⬜ Pendente |
| Ack explícito de comandos | 3 | ⬜ Pendente |
| Modo sessão ativa (rejeita comandos destrutivos) | 3 | ⬜ Pendente |
| Alertas Telegram | 3 | ⬜ Pendente |
| Audit log de comandos | 3 | ⬜ Pendente |
| Auth via BOT_API_KEY | 1 | ⬜ Pendente |

---

## 8. Conectividade

```
AYA1 (Windows)
  └── WireGuard VPN ──→ Media Server (10.253.0.11:3000)

Portal AYA (Unraid, 192.168.15.169)
  └── WireGuard VPN ──→ Media Server (10.253.0.11:3000)
      └── Proxy: /api/expo/beleza-astral/* → http://10.253.0.11:3000/api/*
```

**Verificar antes do Ciclo 1:** o Unraid tem rota para 10.253.0.11 via WireGuard?
Se não, o proxy precisa passar pelo AYA1 ou o Unraid precisa de peer WireGuard.

**Alternativa:** expo-tools envia dados para o portal (push), em vez do portal buscar (pull).
Isso é exatamente o que o Ciclo 2 resolve com WebSocket outbound.

Para o Ciclo 1 (polling), o portal precisa alcançar o media server.

---

## 9. Roadmap Visual

```
Ciclo 1 ─── Presença ──────── polling, proxy, página simples
  │                            (sem WS, sem banco, sem comandos)
  │
Ciclo 2 ─── Sync ─────────── WebSocket outbound, tempo real
  │                            (sem comandos)
  │
Ciclo 3 ─── Controle ─────── comandos remotos + proteções
  │                            (sessão ativa, ack, alertas, audit)
  │
Ciclo 4 ─── Escala ──────── multi-expo, CV, relatórios
```

---

## 10. Auditores Consultados

| Data | Agente | Tipo | Veredicto |
|------|--------|------|-----------|
| 2026-03-18 | Casey Reas | Agente de Saber | Repensar: presença > controle. Experimento mínimo primeiro. |
| 2026-03-18 | Case "Black Ice" Mori | Auditor de Sistemas | Aprovado com 6 ressalvas. Ciclos progressivos mitigam risco. |
