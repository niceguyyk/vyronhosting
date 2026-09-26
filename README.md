# Vyron Hosting

Vyron Hosting ist eine selbst gehostete Hosting-Plattform für virtuelle Server,
Node.js-Websites, Minecraft-Server und verwaltete Domains. Dieses Repository
enthält das Kunden-Dashboard, das Adminpanel, die öffentliche Statusseite, die
zentrale API und den Agenten für den Compute-Host.

> **Wichtig:** Zugangsdaten gehören niemals in Git. Die Plattform liest Secrets
> aus geschützten Dateien unter `/home/x1/.config/vyron/` oder aus
> Umgebungsvariablen. Diese Dateien werden von diesem Repository nicht verwaltet.

## Komponenten

| Ordner | Dienst | Standard-Port | Aufgabe |
| --- | --- | ---: | --- |
| [`Webserver`](./Webserver) | `vyron-app` | `3001` | React/Vite-Kundenportal, Landingpage und Node-Verwaltung |
| [`Appserver`](./Appserver) | `vyron-panel` | `3002` | Server für das Vyron-Adminpanel |
| [`Statusserver`](./Statusserver) | `vyron-status` | `3004` | Öffentliche Statusseite und Discord Embedded Activity |
| [`API`](./API) | `vyron-api` | `8787` | Authentifizierung, Workspaces, Abrechnung, Domains, MCP und Orchestrierung |
| [`Agent`](./Agent) | `vyron-agent` | `8790` | Compute-Host-Agent, VM-Provisionierung, Dateien, Terminal und Minecraft |
| [`scripts`](./scripts) | Hilfsprogramme | – | Betriebs- und Statusskripte |

Weitere zentrale Dateien:

- [`ecosystem.config.cjs`](./ecosystem.config.cjs) startet alle Dienste mit PM2.
- [`DomainConnect/vyronhosting.com.hosting.json`](./DomainConnect/vyronhosting.com.hosting.json)
  beschreibt die Vyron-Domain-Connect-Konfiguration.
- [`Agent/vyron-provision`](./Agent/vyron-provision) ist das privilegierte
  Provisionierungsprogramm für Linux/libvirt.
- [`Agent/vyron-agent.sudoers`](./Agent/vyron-agent.sudoers) begrenzt die dafür
  erlaubten `sudo`-Aufrufe.

## Architektur

```text
Browser
  ├── app.vyronhosting.com ───────> Webserver
  ├── Adminpanel ─────────────────> Appserver
  └── status.vyronpanel.com ──────> Statusserver
                                      │
Webserver / Appserver ───────────────> API
                                      │
                                      ├── PostgreSQL / lokaler State
                                      ├── Stripe, PayPal und Cloudflare
                                      └── Agent (nur intern)
                                             │
                                             └── libvirt/KVM-Gäste
```

Der Agent darf nicht direkt öffentlich erreichbar sein. Die API authentifiziert
interne Agent-Anfragen mit einem separaten Token. Öffentliche Node-Hostnamen
werden über Cloudflare Tunnel an den Router des Agenten weitergeleitet.

## Voraussetzungen

- Node.js 22 oder neuer
- npm
- PM2 für den Produktionsbetrieb
- Linux auf dem Compute-Host
- libvirt/KVM und die für `vyron-provision` benötigten Systemprogramme
- optional PostgreSQL; ohne `DATABASE_URL` verwendet die API lokalen JSON-State
- ein Cloudflare-Konto und Tunnel für verwaltete Domains
- Stripe- beziehungsweise PayPal-Testzugänge für Zahlungsfunktionen

## Installation

Repository klonen und alle Abhängigkeiten installieren:

```bash
git clone https://github.com/niceguyyk/vyronhosting.git
cd vyronhosting
npm run install:all
```

Frontend und Discord Activity bauen:

```bash
npm run build
```

Alle Dienste mit PM2 starten:

```bash
npm install --global pm2
npm start
pm2 save
```

Status prüfen:

```bash
pm2 status
pm2 logs
```

## Lokale Entwicklung

Kundenportal mit Hot Reload:

```bash
cd Webserver
npm install
npm run dev
```

Die übrigen Dienste können jeweils in einem eigenen Terminal gestartet werden:

```bash
cd API && npm start
cd Agent && npm start
cd Appserver && npm start
cd Statusserver && npm start
```

Der Agent benötigt unter Windows keine funktionierende VM-Provisionierung. Für
echte Node-Operationen muss er auf dem vorgesehenen Linux-Compute-Host laufen.

## Konfiguration und Secrets

Die Produktionsinstallation verwendet standardmäßig diese geschützten Dateien:

```text
/home/x1/.config/vyron/api-key
/home/x1/.config/vyron/agent-token
/home/x1/.config/vyron/database-url
/home/x1/.config/vyron/cloudflare-api-token
/home/x1/.config/vyron/cloudflare-account-id
/home/x1/.config/vyron/cloudflare-tunnel-id
/home/x1/.config/vyron/cloudflare-team-name
/home/x1/.config/vyron/stripe-test-secret-key
/home/x1/.config/vyron/stripe-test-publishable-key
/home/x1/.config/vyron/stripe-test-webhook-secret
/home/x1/.config/vyron/turnstile-sitekey
/home/x1/.config/vyron/turnstile-secret
```

Dateirechte sollten auf `600` gesetzt sein. Secrets dürfen weder in Commits noch
in Browser-Bundles landen.

## Compute-Agent installieren

Auf dem Linux-Compute-Host:

```bash
sudo install -o root -g root -m 0755 Agent/vyron-provision /usr/local/sbin/vyron-provision
sudo install -o root -g root -m 0440 Agent/vyron-agent.sudoers /etc/sudoers.d/vyron-agent
sudo visudo -cf /etc/sudoers.d/vyron-agent
```

Danach den Agenten über PM2 starten. Der gemeinsame Agent-Token muss beim Agenten
und bei der API identisch konfiguriert sein.

## Produktion

Die PM2-Konfiguration nutzt folgende Prozesse:

```text
vyron-app       Webserver
vyron-api       API
vyron-panel     Appserver
vyron-status    Statusserver
vyron-agent     Agent
```

Nach einem Update:

```bash
git pull
npm run install:all
npm run build
npm run restart
```

Vor einem Produktiv-Deployment sollten mindestens Syntaxprüfung, Frontend-Build
und ein Smoke-Test aller öffentlichen Routen durchgeführt werden.

## Sicherheit

- Der Agent bleibt ausschließlich im privaten Netzwerk erreichbar.
- API-, Agent-, Cloudflare- und Zahlungs-Keys werden nicht im Repository gespeichert.
- Terminal- und Dateioperationen werden serverseitig autorisiert und protokolliert.
- Backups der Zustandsdaten und der VM-Datenträger müssen außerhalb dieses
  Repositorys gespeichert werden.
- Änderungen an `vyron-provision` oder der sudoers-Datei sollten vor dem Rollout
  separat geprüft werden.

## Lizenz

Proprietäre Software von Vyron Technologies. Eine Nutzung, Weitergabe oder
Veröffentlichung außerhalb des autorisierten Vyron-Betriebs ist ohne vorherige
Erlaubnis nicht gestattet.
