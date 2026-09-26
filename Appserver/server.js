import express from 'express'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const app = express()
const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(root, '../Webserver/dist')

app.disable('x-powered-by')
app.all('/api/mcp', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:8787/mcp', {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        Accept: req.headers.accept || 'application/json, text/event-stream',
        Authorization: req.headers.authorization || '',
        ...(req.headers['mcp-protocol-version'] ? { 'MCP-Protocol-Version': req.headers['mcp-protocol-version'] } : {}),
        ...(req.headers['mcp-session-id'] ? { 'Mcp-Session-Id': req.headers['mcp-session-id'] } : {}),
        'X-Forwarded-Proto': req.headers['x-forwarded-proto'] || req.protocol
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body
    })
    for (const header of ['content-type', 'cache-control', 'mcp-session-id']) {
      const value = response.headers.get(header); if (value) res.setHeader(header, value)
    }
    res.status(response.status)
    if (!response.body) return res.end()
    Readable.fromWeb(response.body).pipe(res)
  } catch { res.status(502).json({ error: 'MCP API unavailable' }) }
})
app.use('/api', express.json({ limit: '30mb' }), async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:8787${req.originalUrl.slice(4)}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: req.headers.authorization || '',
        Cookie: req.headers.cookie || '',
        'X-Forwarded-Proto': req.headers['x-forwarded-proto'] || req.protocol
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body)
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) res.setHeader('Set-Cookie', setCookie)
    res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(await response.text())
  } catch { res.status(502).json({ error: 'API unavailable' }) }
})

app.use(express.static(dist, {
  maxAge: 0,
  setHeaders: (res, file) => {
    if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    else if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}))
app.use((_, res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(path.join(dist, 'index.html')) })

const port = Number(process.env.PORT || 3002)
const server = http.createServer(app)
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/api/v1/vms/')) { socket.destroy(); return }
  const upstream = net.connect(8787, '127.0.0.1', () => {
    const headers = Object.entries(req.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n')
    upstream.write(`${req.method} ${req.url.slice(4)} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  const close = () => { socket.destroy(); upstream.destroy() }
  upstream.on('error', close); socket.on('error', close)
})
server.listen(port, '0.0.0.0', () => console.log(`Vyron control panel listening on :${port}`))
