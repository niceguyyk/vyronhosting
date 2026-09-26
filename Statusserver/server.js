import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const indexFile = path.join(root, 'public', 'index.html')
const discordFile = path.join(root, 'public', 'discord.html')
const discordScriptFile = path.join(root, 'public', 'discord-activity.js')
const mapFile = path.join(root, 'public', 'world-map.png')
const statusScriptFile = path.join(root, 'public', 'status.js')
const faviconFile = path.join(root, 'public', 'favicon.svg')
const port = Number(process.env.PORT || 3004)

const send = (res, status, body, type = 'text/plain; charset=utf-8', { embeddable = false } = {}) => {
  const framePolicy = embeddable
    ? "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com"
    : "frame-ancestors 'none'"
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    ...(embeddable ? {} : { 'X-Frame-Options': 'DENY' }),
    'Content-Security-Policy': `${framePolicy}; default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'`,
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname === '/health') return send(res, 200, JSON.stringify({ status: 'ok', service: 'vyron-status' }), 'application/json; charset=utf-8')
  if (pathname === '/discord/config') {
    return send(res, 200, JSON.stringify({ clientId: process.env.DISCORD_CLIENT_ID || '' }), 'application/json; charset=utf-8', { embeddable: true })
  }
  if (pathname === '/api/v1/status' || pathname === '/discord/api/v1/status') {
    try {
      const response = await fetch('http://127.0.0.1:8787/v1/status', { signal: AbortSignal.timeout(8000) })
      return send(res, response.status, await response.text(), response.headers.get('content-type') || 'application/json; charset=utf-8')
    } catch {
      return send(res, 502, JSON.stringify({ error: 'Status API unavailable' }), 'application/json; charset=utf-8')
    }
  }
  if (pathname === '/world-map.png') {
    try {
      const image = await fs.readFile(mapFile)
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
      return res.end(image)
    } catch {
      return send(res, 404, 'Not found')
    }
  }
  if (pathname === '/status.js') {
    try {
      return send(res, 200, await fs.readFile(statusScriptFile), 'text/javascript; charset=utf-8')
    } catch {
      return send(res, 404, 'Not found')
    }
  }
  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
    try {
      return send(res, 200, await fs.readFile(faviconFile), 'image/svg+xml; charset=utf-8')
    } catch {
      return send(res, 404, 'Not found')
    }
  }
  if (pathname === '/discord-activity.js' || pathname === '/discord/discord-activity.js') {
    try {
      return send(res, 200, await fs.readFile(discordScriptFile), 'text/javascript; charset=utf-8', { embeddable: true })
    } catch {
      return send(res, 404, 'Not found')
    }
  }
  if (pathname === '/discord' || pathname === '/discord/') {
    try {
      return send(res, 200, await fs.readFile(discordFile), 'text/html; charset=utf-8', { embeddable: true })
    } catch {
      return send(res, 500, 'Discord status activity unavailable')
    }
  }
  if (pathname !== '/' && pathname !== '/index.html') return send(res, 404, 'Not found')
  try {
    send(res, 200, await fs.readFile(indexFile), 'text/html; charset=utf-8')
  } catch {
    send(res, 500, 'Status page unavailable')
  }
})

server.listen(port, '127.0.0.1', () => console.log(`Vyron status page listening on :${port}`))
