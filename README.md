# Vyron Hosting

Vyron Hosting is a self-hosted platform for virtual servers, Node.js websites,
Minecraft servers, and managed domains. This repository contains the customer
dashboard, administration panel, public status page, central API, and the agent
that controls the compute host.

> **Important:** Credentials must never be committed to Git. The platform reads
> secrets from protected files under `/home/x1/.config/vyron/` or from
> environment variables. Those files are not managed by this repository.

## Components

| Directory | Service | Default port | Purpose |
| --- | --- | ---: | --- |
| [`Webserver`](./Webserver) | `vyron-app` | `3001` | React/Vite customer portal, landing page, and node management |
| [`Appserver`](./Appserver) | `vyron-panel` | `3002` | Server for the Vyron administration panel |
| [`Statusserver`](./Statusserver) | `vyron-status` | `3004` | Public status page and Discord Embedded Activity |
| [`API`](./API) | `vyron-api` | `8787` | Authentication, workspaces, billing, domains, MCP, and orchestration |
| [`Agent`](./Agent) | `vyron-agent` | `8790` | Compute-host agent, VM provisioning, files, terminal, and Minecraft |
| [`scripts`](./scripts) | Utilities | – | Operational and status scripts |

Other important files:

- [`ecosystem.config.cjs`](./ecosystem.config.cjs) starts all services with PM2.
- [`DomainConnect/vyronhosting.com.hosting.json`](./DomainConnect/vyronhosting.com.hosting.json)
  contains the Vyron Domain Connect template.
- [`Agent/vyron-provision`](./Agent/vyron-provision) is the privileged Linux and
  libvirt provisioning utility.
- [`Agent/vyron-agent.sudoers`](./Agent/vyron-agent.sudoers) restricts the
  `sudo` commands available to the agent.

## Architecture

```text
Browser
  ├── app.vyronhosting.com ───────> Webserver
  ├── Administration panel ───────> Appserver
  └── status.vyronpanel.com ──────> Statusserver
                                      │
Webserver / Appserver ───────────────> API
                                      │
                                      ├── PostgreSQL / local state
                                      ├── Stripe, PayPal, and Cloudflare
                                      └── Agent (internal only)
                                             │
                                             └── libvirt/KVM guests
```

The agent must not be exposed directly to the public internet. The API
authenticates internal agent requests with a dedicated token. Public node
hostnames are routed through Cloudflare Tunnel to the agent's public router.

## Requirements

- Node.js 22 or newer
- npm
- PM2 for production process management
- Linux on the compute host
- libvirt/KVM and the system utilities required by `vyron-provision`
- optional PostgreSQL; without `DATABASE_URL`, the API uses local JSON state
- a Cloudflare account and tunnel for managed domains
- Stripe and/or PayPal test credentials for payment features

## Installation

Clone the repository and install all dependencies:

```bash
git clone https://github.com/niceguyyk/vyronhosting.git
cd vyronhosting
npm run install:all
```

Build the customer frontend and Discord Activity:

```bash
npm run build
```

Start all services with PM2:

```bash
npm install --global pm2
npm start
pm2 save
```

Check their status:

```bash
pm2 status
pm2 logs
```

## Local development

Start the customer portal with hot reload:

```bash
cd Webserver
npm install
npm run dev
```

The other services can be started in separate terminals:

```bash
cd API && npm start
cd Agent && npm start
cd Appserver && npm start
cd Statusserver && npm start
```

The agent can run on Windows for limited development purposes, but actual VM
provisioning requires the designated Linux compute host.

## Configuration and secrets

The production installation uses the following protected files by default:

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

These files should use permissions `600`. Secrets must never be included in
commits or client-side browser bundles.

## Installing the compute agent

Run the following commands on the Linux compute host:

```bash
sudo install -o root -g root -m 0755 Agent/vyron-provision /usr/local/sbin/vyron-provision
sudo install -o root -g root -m 0440 Agent/vyron-agent.sudoers /etc/sudoers.d/vyron-agent
sudo visudo -cf /etc/sudoers.d/vyron-agent
```

Then start the agent through PM2. The API and agent must be configured with the
same internal agent token.

## Production

The PM2 configuration defines the following processes:

```text
vyron-app       Webserver
vyron-api       API
vyron-panel     Appserver
vyron-status    Statusserver
vyron-agent     Agent
```

To deploy an update:

```bash
git pull
npm run install:all
npm run build
npm run restart
```

Before a production deployment, run syntax checks, build the frontend, and
perform smoke tests against every public route.

## Security

- Keep the agent accessible only from the private network.
- Do not store API, agent, Cloudflare, or payment credentials in this repository.
- Authorize and audit terminal and file operations on the server side.
- Store state and VM disk backups outside this repository.
- Review changes to `vyron-provision` and the sudoers policy separately before
  deploying them.

## License

Proprietary software by Vyron Technologies. Use, redistribution, or publication
outside the authorized Vyron environment is not permitted without prior approval.
