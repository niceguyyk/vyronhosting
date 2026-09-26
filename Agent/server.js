import express from 'express'
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import * as pty from 'node-pty'
import { WebSocketServer } from 'ws'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const run = promisify(execFile)
const app = express()
const jobs = new Map()
const fileUploads = new Map()
const MAX_FILE_UPLOAD = 1024 ** 3
const MAX_UPLOAD_CHUNK = 8 * 1024 ** 2
const jobsFile = process.env.VYRON_JOBS_FILE || '/home/x1/.local/share/vyron/agent-jobs.json'
let infrastructureQueue = Promise.resolve()
const vmSamples = new Map()
const publicRoutes = new Map()
const routesFile = process.env.VYRON_ROUTES_FILE || '/home/x1/.local/share/vyron/public-domains.json'
const platformDataFile = process.env.VYRON_DATA_FILE || '/home/x1/.local/share/vyron/data.json'
const customRoutes = new Map()
try {
  if (fs.existsSync(routesFile)) {
    const stored = JSON.parse(fs.readFileSync(routesFile, 'utf8'))
    for (const [hostname, route] of Object.entries(stored || {})) customRoutes.set(hostname, typeof route === 'string' ? { node: route, pathPrefix: '' } : route)
  }
} catch {}
const saveCustomRoutes = () => {
  fs.mkdirSync(path.dirname(routesFile), { recursive: true })
  fs.writeFileSync(routesFile, JSON.stringify(Object.fromEntries(customRoutes), null, 2), { mode: 0o600 })
}
const tokenFile = process.env.AGENT_TOKEN_FILE || '/home/x1/.config/vyron/agent-token'
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const minecraftRuntime = fs.readFileSync(new URL('./minecraft-runtime.cjs', import.meta.url), 'utf8')

try {
  if (fs.existsSync(jobsFile)) {
    const storedJobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'))
    for (const job of Array.isArray(storedJobs) ? storedJobs : []) {
      if (job?.id) jobs.set(job.id, ['queued', 'provisioning'].includes(job.state) ? { ...job, state: 'interrupted', error: 'The control agent restarted before this job completed.' } : job)
    }
  }
} catch {}
const saveJobs = () => {
  fs.mkdirSync(path.dirname(jobsFile), { recursive: true, mode: 0o700 })
  const temporary = `${jobsFile}.tmp`
  fs.writeFileSync(temporary, JSON.stringify([...jobs.values()].slice(-500), null, 2), { mode: 0o600 })
  fs.renameSync(temporary, jobsFile)
}
const updateJob = (id, update) => {
  const current = jobs.get(id)
  if (!current) return null
  const next = { ...current, ...update, updatedAt: new Date().toISOString() }
  jobs.set(id, next)
  saveJobs()
  return next
}
const queueInfrastructureTask = task => {
  const queued = infrastructureQueue.then(task, task)
  infrastructureQueue = queued.catch(() => {})
  return queued
}
const platformNodes = () => {
  try {
    const state = JSON.parse(fs.readFileSync(platformDataFile, 'utf8'))
    return (state.vms || []).filter(vm => !['deleted', 'failed', 'missing'].includes(vm.status))
  } catch { return [] }
}
const capacitySnapshot = (excludeName = '') => {
  const nodes = platformNodes().filter(vm => vm.name !== excludeName)
  const knownNames = new Set(nodes.map(vm => vm.name))
  const pending = [...jobs.values()].filter(job => ['queued', 'provisioning'].includes(job.state) && job.name !== excludeName && !knownNames.has(job.name))
  const allocated = [...nodes.map(vm => ({ cpu: vm.cpu, ram: vm.ram, disk: vm.disk })), ...pending.map(job => job.resources || {})]
    .reduce((total, item) => ({ cpu: total.cpu + Number(item.cpu || 0), ram: total.ram + Number(item.ram || 0), disk: total.disk + Number(item.disk || 0) }), { cpu: 0, ram: 0, disk: 0 })
  const root = fs.statfsSync('/')
  const physicalDisk = root.blocks * root.bsize / 1024 ** 3
  const physicalDiskFree = root.bavail * root.bsize / 1024 ** 3
  // VM disks are QCOW2-backed and therefore thin provisioned. Counting their
  // advertised size as already consumed made a 100 GB plan unavailable on a
  // host with plenty of real free space. Keep a conservative physical reserve,
  // while exposing a configurable logical storage pool for virtual disks.
  const diskReserve = Math.max(10, Number(process.env.VYRON_DISK_RESERVE_GB || 15))
  const diskOvercommit = Math.max(1, Number(process.env.VYRON_DISK_OVERCOMMIT || 1))
  const limits = {
    // The provisioner supports all four host vCPUs. Linux scheduling still
    // leaves the control plane responsive; the old extra reservation caused
    // the dashboard and provisioner to disagree.
    cpu: Math.max(0.5, os.cpus().length),
    ram: Math.max(0.5, Math.floor((os.totalmem() / 1024 ** 3 - 2) * 2) / 2),
    disk: Math.max(20, Math.floor(((physicalDisk - diskReserve) * diskOvercommit) / 5) * 5)
  }
  return {
    limits,
    allocated,
    available: {
      cpu: Math.max(0, limits.cpu - allocated.cpu),
      ram: Math.max(0, limits.ram - allocated.ram),
      disk: physicalDiskFree <= diskReserve ? 0 : Math.max(0, limits.disk - allocated.disk)
    },
    reserved: { cpu: 0, ram: 2, disk: diskReserve },
    physical: {
      diskTotal: +physicalDisk.toFixed(1),
      diskFree: +physicalDiskFree.toFixed(1),
      diskOvercommit
    }
  }
}
const capacityError = (resources, excludeName = '') => {
  const capacity = capacitySnapshot(excludeName)
  const missing = ['cpu', 'ram', 'disk'].filter(key => Number(resources[key] || 0) > capacity.available[key])
  return missing.length ? { error: `Not enough server capacity for ${missing.join(', ')}. Try a smaller plan or wait for capacity to become available.`, capacity } : null
}

app.disable('x-powered-by')
app.use(express.json({ limit: '30mb' }))
const authorizedAgentRequest = req => {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  return supplied.length === token.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
}
app.use((req, res, next) => {
  if (req.path === '/health') return next()
  if (!authorizedAgentRequest(req)) return res.status(401).json({ error: 'Unauthorized' })
  next()
})

app.get('/health', async (_, res) => {
  const cpu = Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 1000) / 10)
  const totalRam = os.totalmem() / 1024 ** 3
  const usedRam = totalRam - os.freemem() / 1024 ** 3
  let networkBytes = 0
  try {
    networkBytes = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).reduce((sum, line) => {
      const values = line.trim().split(/[:\s]+/)
      return sum + (Number(values[1]) || 0) + (Number(values[9]) || 0)
    }, 0)
  } catch {}
  const root = fs.statfsSync('/')
  const totalStorage = root.blocks * root.bsize / 1024 ** 3
  const usedStorage = (root.blocks - root.bavail) * root.bsize / 1024 ** 3
  let gpu = { available: false, name: null, utilization: null, usedVramMb: null, totalVramMb: null }
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000 })
    const [name, utilization, usedVramMb, totalVramMb] = stdout.trim().split('\n')[0].split(',').map(value => value.trim())
    gpu = { available: true, name, utilization: Number(utilization), usedVramMb: Number(usedVramMb), totalVramMb: Number(totalVramMb) }
  } catch {}
  let services = []
  try {
    const { stdout } = await run('pm2', ['jlist'], { timeout: 5000, maxBuffer: 512 * 1024 })
    services = JSON.parse(stdout).filter(item => item.name.startsWith('vyron-')).map(item => ({ name: item.name, status: item.pm2_env?.status || 'unknown', restarts: item.pm2_env?.restart_time || 0, memoryMb: +((item.monit?.memory || 0) / 1024 ** 2).toFixed(1), cpu: item.monit?.cpu || 0 }))
  } catch {}
  res.json({ status: 'ok', host: 'vyron-servers', virtualization: 'managed', gpuScheduling: gpu.available, location: { id: 'de-muc-1', country: 'Germany', city: 'Munich', region: 'EU Central', latitude: 48.137, longitude: 11.575, status: 'operational' }, capacity: capacitySnapshot(), system: { platform: os.platform(), release: os.release(), loadAverage: os.loadavg().map(value => +value.toFixed(2)), services }, metrics: { cpu, cpuCores: os.cpus().length, usedRam: +usedRam.toFixed(1), totalRam: +totalRam.toFixed(1), usedStorage: +usedStorage.toFixed(1), totalStorage: +totalStorage.toFixed(1), networkGb: +(networkBytes / 1024 ** 3).toFixed(2), uptime: Math.round(os.uptime()), gpu } })
})

app.get('/v1/capacity', (_, res) => res.json(capacitySnapshot()))

app.get('/v1/vms', async (_, res) => {
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'list'], { timeout: 15000 })
    res.json(JSON.parse(stdout))
  } catch (error) { res.status(500).json({ error: error.stderr?.trim() || error.message }) }
})

const publicRouter = http.createServer(async (req, res) => {
  const hostname = String(req.headers.host || '').split(':')[0].toLowerCase()
  const match = hostname.match(/^([a-z][a-z0-9-]{2,31})\.vyronhosting\.com$/)
  const customRoute = customRoutes.get(hostname)
  const name = match?.[1] || customRoute?.node
  if (!name) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Unknown Vyron hostname') }
  try {
    const platform = JSON.parse(fs.readFileSync(platformDataFile, 'utf8'))
    const node = (platform.vms || []).find(item => item.name === name && item.status !== 'deleted')
    if (node?.template === 'minecraft') {
      res.writeHead(302, { Location: 'https://vyronhosting.com', 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' })
      return res.end('Minecraft hosting by Vyron Technologies')
    }
    let route = publicRoutes.get(name)
    if (!route || Date.now() - route.cachedAt > 5000) {
      const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'route', name], { timeout: 10000 })
      route = { ...JSON.parse(stdout), cachedAt: Date.now() }
      publicRoutes.set(name, route)
    }
    if (route.status !== 'running' || !route.ip) throw new Error('Node is not available')
    const proxy = http.request({
      hostname: route.ip,
      port: 80,
      path: customRoute?.pathPrefix ? `${customRoute.pathPrefix}${String(req.url || '/').startsWith('/') ? req.url : `/${req.url}`}` : req.url,
      method: req.method,
      headers: { ...req.headers, host: hostname, 'x-forwarded-host': hostname, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https' },
      timeout: 30000
    }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers)
      upstream.pipe(res)
    })
    proxy.on('timeout', () => proxy.destroy(new Error('Node request timed out')))
    proxy.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`Node unavailable: ${error.message}`)
    })
    req.pipe(proxy)
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end(`Node unavailable: ${error.stderr?.trim() || error.message}`)
  }
})

app.post('/v1/domains', (req, res) => {
  const hostname = String(req.body.hostname || '').trim().toLowerCase().replace(/\.$/, '')
  const name = String(req.body.node || '').trim().toLowerCase()
  const pathPrefix = String(req.body.pathPrefix || '').trim()
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) return res.status(400).json({ error: 'Invalid domain name.' })
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name.' })
  if (pathPrefix && !/^\/[1-5]$/.test(pathPrefix)) return res.status(400).json({ error: 'Invalid website path.' })
  customRoutes.set(hostname, { node: name, pathPrefix }); saveCustomRoutes(); res.status(201).json({ hostname, node: name, pathPrefix, status: 'active' })
})
app.delete('/v1/domains/:hostname', (req, res) => {
  const hostname = decodeURIComponent(req.params.hostname).trim().toLowerCase().replace(/\.$/, '')
  customRoutes.delete(hostname); saveCustomRoutes(); res.json({ ok: true })
})

app.post('/v1/vms', (req, res) => {
  const { name, resources = {}, template = 'ubuntu' } = req.body
  const cpu = Number(resources.cpu)
  const ram = Number(resources.ram)
  const disk = Number(resources.disk || 20)
  const gpu = Number(resources.gpuShare || 0)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name || '')) return res.status(400).json({ error: 'Invalid node name' })
  if (![.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].includes(cpu)) return res.status(400).json({ error: 'CPU must be 0.5–4 in 0.5 increments' })
  if (ram < .5 || ram > 12 || ram * 2 % 1 !== 0) return res.status(400).json({ error: 'RAM must be 0.5–12 GB in 0.5 increments' })
  if (disk < 20 || disk > 500 || (disk !== 20 && disk % 100 !== 0)) return res.status(400).json({ error: 'Disk must be 20 GB or 100–500 GB in 100 GB increments' })
  if (gpu > 0 || Number(resources.vram || 0) > 0) return res.status(409).json({ error: 'GPU sharing is not available on the current server platform' })
  if (!['ubuntu', 'node', 'nginx', 'python', 'minecraft'].includes(template)) return res.status(400).json({ error: 'Unsupported template' })
  const capacityFailure = capacityError({ cpu, ram, disk })
  if (capacityFailure) return res.status(409).json(capacityFailure)

  const id = crypto.randomUUID()
  const job = { id, name, type: 'create', state: 'queued', stage: 'Waiting for server capacity', resources: { cpu, ram, disk }, template, createdAt: new Date().toISOString() }
  jobs.set(id, job)
  saveJobs()
  res.status(202).json(job)

  const guestTemplate = template === 'minecraft' ? 'ubuntu' : template
  queueInfrastructureTask(async () => {
    const failure = capacityError({ cpu, ram, disk }, name)
    if (failure) throw Object.assign(new Error(failure.error), { capacity: failure.capacity })
    const existing = platformNodes().find(node => node.name === name)
    updateJob(id, { state: 'provisioning', stage: existing ? 'Recovering existing virtual machine' : 'Creating virtual machine', startedAt: new Date().toISOString() })
    let result
    if (existing) {
      result = { name, username: 'vyron', status: String(existing.status).toLowerCase() === 'running' ? 'running' : 'stopped', recovered: true }
    } else {
      const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'create', name, String(cpu), String(ram), String(disk), guestTemplate], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 })
      result = JSON.parse(stdout.trim().split('\n').at(-1))
    }
    updateJob(id, { stage: 'Configuring secure network access' })
    const accessResult = await run('sudo', ['/usr/local/sbin/vyron-provision', 'gateway-sync', name], { timeout: 30000, maxBuffer: 128 * 1024 })
    const access = JSON.parse(accessResult.stdout.trim().split('\n').at(-1))
    updateJob(id, { state: 'running', stage: 'Ready', completedAt: new Date().toISOString(), result: { ...result, access } })
  }).catch(error => updateJob(id, { state: 'failed', stage: 'Failed', completedAt: new Date().toISOString(), error: error.stderr?.trim() || error.message, capacity: error.capacity }))
})

app.get('/v1/jobs/:id', (req, res) => jobs.has(req.params.id) ? res.json(jobs.get(req.params.id)) : res.status(404).json({ error: 'Job not found' }))

app.get('/v1/vms/:name/access', async (req, res) => {
  const name = req.params.name
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'gateway-sync', name], { timeout: 30000, maxBuffer: 128 * 1024 })
    res.json(JSON.parse(stdout.trim().split('\n').at(-1)))
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
})

app.get('/v1/vms/:name/metrics', async (req, res) => {
  const name = req.params.name
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'metrics', name], { timeout: 15000 })
    const raw = JSON.parse(stdout)
    const now = Date.now(), cpuTime = Number(raw.cpuTime || 0), vcpus = Number(raw.vcpus || 1), rxBytes = Number(raw.rxBytes || 0), txBytes = Number(raw.txBytes || 0)
    const previous = vmSamples.get(name)
    let cpu = 0
    if (previous && cpuTime >= previous.cpuTime) cpu = Math.max(0, Math.min(100, (cpuTime - previous.cpuTime) / ((now - previous.at) * 1e6 * Math.max(1, vcpus)) * 100))
    let networkMbps = 0
    if (previous && rxBytes + txBytes >= previous.rxBytes + previous.txBytes) networkMbps = (rxBytes + txBytes - previous.rxBytes - previous.txBytes) * 8 / Math.max(1, now - previous.at) / 1000
    vmSamples.set(name, { cpuTime, rxBytes, txBytes, at: now })
    const currentKiB = Number(raw.currentKiB || 0), unusedKiB = Number(raw.unusedKiB || 0)
    const usedRamMb = Math.max(0, (currentKiB - unusedKiB) / 1024)
    res.json({ name, status: raw.status, cpu: +cpu.toFixed(1), usedRamMb: +usedRamMb.toFixed(1), allocatedRamMb: +(currentKiB / 1024).toFixed(1), diskUsedGb: +(Number(raw.diskUsedBytes || 0) / 1024 ** 3).toFixed(2), diskTotalGb: +(Number(raw.diskTotalBytes || 0) / 1024 ** 3).toFixed(2), networkMbps: +networkMbps.toFixed(3), networkTotalMb: +((rxBytes + txBytes) / 1024 ** 2).toFixed(1), ip: raw.ip || null, at: new Date(now).toISOString() })
  } catch (error) { res.status(404).json({ error: error.stderr?.trim() || error.message }) }
})

app.get('/v1/vms/:name/status', async (req, res) => {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(req.params.name)) return res.status(400).json({ error: 'Invalid node name' })
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'status', req.params.name], { timeout: 15000 })
    res.json(JSON.parse(stdout))
  } catch (error) { res.status(404).json({ error: error.stderr?.trim() || error.message }) }
})

app.post('/v1/host/exec', async (req, res) => {
  const command = String(req.body.command || '')
  if (!command.trim() || command.length > 2000) return res.status(400).json({ error: 'Command must be 1–2000 characters' })
  try {
    const { stdout, stderr } = await run('/bin/bash', ['-lc', command], { timeout: 30000, maxBuffer: 128 * 1024 })
    res.json({ host: 'vyron-servers', user: 'administrator', exitCode: 0, stdout, stderr })
  } catch (error) {
    res.status(422).json({ host: 'vyron-servers', user: 'administrator', exitCode: Number(error.code) || 1, stdout: error.stdout || '', stderr: error.stderr || error.message })
  }
})

app.post('/v1/vms/:name/exec', async (req, res) => {
  const name = req.params.name, command = String(req.body.command || ''), cwd = String(req.body.cwd || '/root')
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  if (!command.trim() || command.length > 2000) return res.status(400).json({ error: 'Command must be 1–2000 characters' })
  if (!/^\/[\x20-\x7E]{0,299}$/.test(cwd) || cwd.includes('..')) return res.status(400).json({ error: 'Invalid working directory' })
  try {
    const encoded = Buffer.from(command, 'utf8').toString('base64')
    const encodedCwd = Buffer.from(cwd, 'utf8').toString('base64')
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'exec', name, encoded, encodedCwd], { timeout: 35000, maxBuffer: 256 * 1024 })
    res.json(JSON.parse(stdout))
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || 'Guest Agent is not ready yet.' }) }
})

app.post('/v1/vms/:name/ssh-password', async (req, res) => {
  const name = req.params.name
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'ssh-password-reset', name], { timeout: 8 * 60 * 1000, maxBuffer: 256 * 1024 })
    res.json(JSON.parse(stdout.trim().split('\n').at(-1)))
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
})

app.get('/v1/vms/:name/logs', async (req, res) => {
  const name = req.params.name
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  const lines = Math.min(500, Math.max(20, Number(req.query.lines) || 200))
  const command = `printf '%s\\n' '--- process ---'; ps -eo pid,lstart,cmd | grep -E 'node|nginx' | grep -v grep | tail -n ${lines}; printf '%s\\n' '--- nginx ---'; tail -n ${lines} /var/log/nginx/access.log /var/log/nginx/error.log 2>/dev/null || true; printf '%s\\n' '--- application logs ---'; find /srv/vyron -maxdepth 5 -type f \( -name '*.log' -o -name 'npm-debug.log*' \) -print -exec tail -n ${lines} {} \; 2>/dev/null || true`
  try {
    const encoded = Buffer.from(command, 'utf8').toString('base64')
    const cwd = Buffer.from('/root', 'utf8').toString('base64')
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'exec', name, encoded, cwd], { timeout: 35000, maxBuffer: 512 * 1024 })
    const result = JSON.parse(stdout)
    res.json({ name, lines, output: result.stdout || '', stderr: result.stderr || '' })
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
})

app.put('/v1/vms/:name/runtime-settings', async (req, res) => {
  const name = req.params.name
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  const environment = req.body.environment && typeof req.body.environment === 'object' && !Array.isArray(req.body.environment) ? req.body.environment : {}
  const entries = Object.entries(environment)
  if (entries.length > 30 || entries.some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 2000 || /[\0\r\n]/.test(value))) return res.status(400).json({ error: 'Environment variables must use safe uppercase names and values up to 2000 characters.' })
  const autoRestart = req.body.autoRestart !== false
  const envFile = entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + (entries.length ? '\n' : '')
  const encoded = Buffer.from(envFile).toString('base64')
  const command = `set -e
printf '%s' '${encoded}' | base64 -d >/etc/vyron-node.env
chmod 600 /etc/vyron-node.env
mkdir -p /etc/systemd/system/vyron-node.service.d
printf '[Unit]\\nStartLimitIntervalSec=60\\nStartLimitBurst=5\\n[Service]\\nEnvironmentFile=-/etc/vyron-node.env\\nRestart=${autoRestart ? 'on-failure' : 'no'}\\nRestartSec=3\\n' >/etc/systemd/system/vyron-node.service.d/10-vyron-runtime.conf
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 20 ]; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
systemctl daemon-reload
systemctl reset-failed vyron-node.service 2>/dev/null || true
if ! systemctl list-unit-files vyron-node.service >/dev/null 2>&1; then echo 'Node.js service has not been deployed yet' >&2; exit 3; fi
systemctl restart vyron-node
app_port=""
for attempt in {1..25}; do
  main_pid="$(systemctl show vyron-node.service -p MainPID --value 2>/dev/null || true)"
  if [ -n "$main_pid" ] && [ "$main_pid" != "0" ]; then
    app_port="$(ss -H -ltnp 2>/dev/null | awk -v pid="$main_pid" '$0 ~ "pid=" pid "," {port=$4; sub(/^.*:/,"",port); if(port ~ /^[0-9]+$/) {print port; exit}}')"
  fi
  if [ -n "$app_port" ] && curl -sS --max-time 3 "http://127.0.0.1:$app_port/" >/dev/null; then break; fi
  app_port=""; sleep 1
done
if [ -z "$app_port" ]; then journalctl -u vyron-node -n 25 --no-pager >&2; exit 4; fi
printf '%s\\n' "$app_port" >/etc/vyron-app-port
if [ ! -f /etc/nginx/sites-available/vyron-node ]; then
  cat >/etc/nginx/sites-available/vyron-node <<EOF
server {
  listen 80 default_server;
  server_name _;
  location / {
    proxy_pass http://127.0.0.1:$app_port;
    proxy_http_version 1.1;
    proxy_set_header Host \\$host;
    proxy_set_header X-Real-IP \\$remote_addr;
    proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \\$scheme;
  }
}
EOF
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/vyron-node /etc/nginx/sites-enabled/vyron-node
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
fi
echo "VYRON_APP_PORT=$app_port"`
  try {
    const payload = Buffer.from(command).toString('base64'), cwd = Buffer.from('/root').toString('base64')
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'exec', name, payload, cwd], { timeout: 8 * 60 * 1000, maxBuffer: 256 * 1024 })
    const result = JSON.parse(stdout)
    if (result.exitCode) throw new Error(result.stderr || 'Runtime settings could not be applied.')
    const appPort = Number(String(result.stdout || '').match(/VYRON_APP_PORT=(\d+)/)?.[1]) || null
    res.json({ name, autoRestart, environmentKeys: entries.map(([key]) => key), appPort, status: 'applied' })
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
})

app.put('/v1/vms/:name/websites', async (req, res) => {
  const name = req.params.name
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  const requested = Array.isArray(req.body.websites) ? req.body.websites : []
  if (requested.length > 5) return res.status(400).json({ error: 'A Node.js node supports up to five websites.' })
  const websites = requested.map(item => ({
    slot: Number(item.slot),
    enabled: item.enabled === true,
    entryFile: validProjectPath(item.entryFile)
  }))
  if (websites.some(item => !Number.isInteger(item.slot) || item.slot < 1 || item.slot > 5 || (item.enabled && (!item.entryFile || item.entryFile === '.' || !/\.(?:js|mjs|cjs)$/i.test(item.entryFile))))) {
    return res.status(400).json({ error: 'Each enabled website needs a safe .js, .mjs or .cjs start file.' })
  }
  if (new Set(websites.map(item => item.slot)).size !== websites.length) return res.status(400).json({ error: 'Website slots must be unique.' })
  const normalized = Array.from({ length: 5 }, (_, index) => websites.find(item => item.slot === index + 1) || { slot: index + 1, enabled: false, entryFile: null })
  const encodedConfig = Buffer.from(JSON.stringify(normalized)).toString('base64')
  const command = "python3 - <<'PY'\nconfig_b64 = '" + encodedConfig + "'\n" + String.raw`
import base64, json, pathlib, subprocess

root = pathlib.Path('/srv/vyron/app').resolve()
sites = json.loads(base64.b64decode(config_b64))
active = []

def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)

for site in sites:
    slot = int(site['slot'])
    service = 'vyron-node-site-' + str(slot) + '.service'
    if not site.get('enabled'):
        subprocess.run(['systemctl', 'disable', '--now', service], capture_output=True)
        pathlib.Path('/etc/systemd/system/' + service).unlink(missing_ok=True)
        continue
    entry = (root / site['entryFile']).resolve()
    if root not in entry.parents or not entry.is_file():
        raise RuntimeError('Website /' + str(slot) + ': start file ' + str(site['entryFile']) + ' does not exist')
    workdir = entry.parent
    package = workdir / 'package.json'
    if package.is_file() and not (workdir / 'node_modules').is_dir():
        install = ['sudo', '-u', 'vyron', 'npm', 'ci', '--include=dev'] if (workdir / 'package-lock.json').is_file() else ['sudo', '-u', 'vyron', 'npm', 'install', '--include=dev']
        run(install, cwd=str(workdir), timeout=600)
    port = 3100 + slot
    unit = f'''[Unit]
Description=Vyron Node.js website /{slot}
After=network.target
[Service]
Type=simple
User=vyron
WorkingDirectory={workdir}
EnvironmentFile=-/etc/vyron-node.env
Environment=NODE_ENV=production
Environment=PORT={port}
Environment=BASE_PATH=/{slot}
ExecStart=/usr/bin/node {entry}
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
'''
    pathlib.Path('/etc/systemd/system/' + service).write_text(unit)
    active.append({'slot': slot, 'path': '/' + str(slot), 'entryFile': site['entryFile'], 'port': port, 'enabled': True})

run(['systemctl', 'daemon-reload'])
for site in active:
    run(['systemctl', 'enable', '--now', 'vyron-node-site-' + str(site['slot']) + '.service'])
    run(['systemctl', 'restart', 'vyron-node-site-' + str(site['slot']) + '.service'])

main_port = 3000
try:
    main_port = int(pathlib.Path('/etc/vyron-app-port').read_text().strip())
except Exception:
    pass
lines = [
    'server {',
    '  listen 80 default_server;',
    '  server_name _;',
    // Keep /1 -> /1/ redirects relative. The guest receives HTTP from the
    // platform router even though the visitor connected through HTTPS.
    '  absolute_redirect off;',
    '  location / {',
    '    proxy_pass http://127.0.0.1:' + str(main_port) + ';',
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '  }'
]
for site in active:
    slot, port = site['slot'], site['port']
    lines += [
        '  location = /' + str(slot) + ' { return 308 /' + str(slot) + '/; }',
        '  location /' + str(slot) + '/ {',
        '    proxy_pass http://127.0.0.1:' + str(port) + '/;',
        '    proxy_http_version 1.1;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Real-IP $remote_addr;',
        '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '    proxy_set_header X-Forwarded-Proto $scheme;',
        '    proxy_set_header X-Forwarded-Prefix /' + str(slot) + ';',
        '  }'
    ]
lines.append('}')
pathlib.Path('/etc/nginx/sites-available/vyron-node').write_text('\n'.join(lines) + '\n')
pathlib.Path('/etc/nginx/sites-enabled/default').unlink(missing_ok=True)
enabled = pathlib.Path('/etc/nginx/sites-enabled/vyron-node')
enabled.unlink(missing_ok=True)
enabled.symlink_to('/etc/nginx/sites-available/vyron-node')
run(['nginx', '-t'])
run(['systemctl', 'enable', '--now', 'nginx'])
run(['systemctl', 'reload', 'nginx'])
for site in active:
    run(['systemctl', 'is-active', '--quiet', 'vyron-node-site-' + str(site['slot']) + '.service'])
print(json.dumps({'websites': active, 'status': 'applied'}))
PY`
  try {
    const result = await guestCommand(name, command, 12 * 60 * 1000)
    if (result.exitCode) throw new Error(result.stderr || result.stdout || 'Website routes could not be applied.')
    res.json(JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).at(-1)))
  } catch (error) { res.status(503).json({ error: error.message }) }
})

app.post('/v1/vms/:name/upgrade', async (req, res) => {
  const name = req.params.name, cpu = Number(req.body.cpu), ram = Number(req.body.ram), disk = Number(req.body.disk)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  if (![.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].includes(cpu)) return res.status(400).json({ error: 'CPU must be between 0.5 and 4 vCPU' })
  if (ram < .5 || ram > 12 || ram * 2 % 1) return res.status(400).json({ error: 'RAM must be between 0.5 and 12 GB in 0.5 GB steps' })
  const currentDisk = Number(platformNodes().find(node => node.name === name)?.disk || 0)
  const supportedDisk = [20, 40, 60, 80].includes(disk) || (disk >= 100 && disk <= 500 && disk % 100 === 0)
  if (!supportedDisk || disk < currentDisk) return res.status(400).json({ error: 'Storage upgrades use 100 GB steps up to 500 GB' })
  const capacityFailure = capacityError({ cpu, ram, disk }, name)
  if (capacityFailure) return res.status(409).json(capacityFailure)
  const id = crypto.randomUUID()
  const job = { id, name, type: 'upgrade', state: 'queued', stage: 'Waiting for other infrastructure jobs', resources: { cpu, ram, disk }, createdAt: new Date().toISOString() }
  jobs.set(id, job); saveJobs()
  try {
    const result = await queueInfrastructureTask(async () => {
      const failure = capacityError({ cpu, ram, disk }, name)
      if (failure) throw Object.assign(new Error(failure.error), { capacity: failure.capacity })
      updateJob(id, { state: 'provisioning', stage: 'Applying resource upgrade', startedAt: new Date().toISOString() })
      const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'upgrade', name, String(cpu), String(ram), String(disk)], { timeout: 180000, maxBuffer: 256 * 1024 })
      return JSON.parse(stdout.trim().split('\n').at(-1))
    })
    updateJob(id, { state: result.status || 'running', stage: 'Ready', completedAt: new Date().toISOString(), result })
    res.json({ ...result, jobId: id })
  } catch (error) {
    updateJob(id, { state: 'failed', stage: 'Failed', completedAt: new Date().toISOString(), error: error.stderr?.trim() || error.message, capacity: error.capacity })
    res.status(error.capacity ? 409 : 500).json({ error: error.stderr?.trim() || error.message, capacity: error.capacity })
  }
})

const readableDeploymentError = error => {
  const raw = String(error.stderr || error.stdout || error.message || 'Deployment failed').trim()
  const missing = raw.match(/\b([A-Z][A-Z0-9_]{2,63})\s+(?:fehlt|is missing|required)/i)
  if (missing) return `Required environment variable ${missing[1].toUpperCase()} is missing. Add it in the Runtime tab and save the settings to start the application.`
  const lines = raw.split(/\r?\n/).filter(line => line.trim() && !/^\s*(?:at |Traceback|File "<stdin>")/.test(line))
  return lines.slice(-16).join('\n').slice(-5000) || 'Deployment failed.'
}

app.post('/v1/vms/:name/deploy', async (req, res) => {
  const name = req.params.name
  const template = String(req.body.template || '')
  const archive = String(req.body.archive || '')
  const entryFile = validProjectPath(req.body.entryFile)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  if (!['node', 'nginx'].includes(template)) return res.status(400).json({ error: 'ZIP deployments are supported for Node.js and Nginx nodes.' })
  if (!entryFile || entryFile === '.' || (template === 'node' ? !/\.(?:js|mjs|cjs)$/i.test(entryFile) : !/\.html?$/i.test(entryFile))) return res.status(400).json({ error: 'Choose a valid deployment entry file.' })
  if (!archive || archive.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(archive)) return res.status(413).json({ error: 'Invalid or oversized ZIP archive.' })

  const bytes = Buffer.from(archive, 'base64')
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return res.status(400).json({ error: 'The upload must be a ZIP file up to 20 MB.' })
  const upload = `/tmp/vyron-upload-${crypto.randomUUID()}.zip`
  try {
    fs.writeFileSync(upload, bytes, { mode: 0o600, flag: 'wx' })
    await run('python3', ['-c', `
import pathlib, stat, sys, zipfile
p = sys.argv[1]
with zipfile.ZipFile(p) as z:
    files = z.infolist()
    if not files or len(files) > 2000: raise SystemExit('Archive must contain 1-2000 entries')
    if sum(x.file_size for x in files) > 250 * 1024 * 1024: raise SystemExit('Expanded archive is too large')
    for x in files:
        name = x.filename.replace('\\\\', '/')
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or not name or stat.S_ISLNK(x.external_attr >> 16):
            raise SystemExit('Archive contains an unsafe path or link')
`, upload], { timeout: 15000, maxBuffer: 64 * 1024 })
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'deploy', name, upload, template, entryFile], { timeout: 12 * 60 * 1000, maxBuffer: 256 * 1024 })
    res.json(JSON.parse(stdout.trim().split('\n').at(-1)))
  } catch (error) {
    res.status(500).json({ error: readableDeploymentError(error) })
  } finally {
    fs.rmSync(upload, { force: true })
  }
})

app.post('/v1/vms/:name/deploy-github', async (req, res) => {
  const name = req.params.name, template = String(req.body.template || ''), repository = String(req.body.repository || '').trim(), branch = String(req.body.branch || '').trim(), entryFile = validProjectPath(req.body.entryFile)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Invalid node name' })
  if (!['node', 'nginx'].includes(template)) return res.status(400).json({ error: 'GitHub deployments are supported for Node.js and Nginx nodes.' })
  if (!entryFile || entryFile === '.' || (template === 'node' ? !/\.(?:js|mjs|cjs)$/i.test(entryFile) : !/\.html?$/i.test(entryFile))) return res.status(400).json({ error: 'Choose a valid deployment entry file.' })
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) return res.status(400).json({ error: 'Use a public GitHub repository URL.' })
  if (branch && !/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) return res.status(400).json({ error: 'Invalid Git branch.' })
  const work = fs.mkdtempSync('/tmp/vyron-git-'), archive = `/tmp/vyron-upload-${crypto.randomUUID()}.zip`
  try {
    const args = ['clone', '--depth', '1', '--single-branch']
    if (branch) args.push('--branch', branch)
    args.push(repository, work)
    await run('git', args, { timeout: 120000, maxBuffer: 256 * 1024 })
    await run('git', ['-C', work, 'archive', '--format=zip', '-o', archive, 'HEAD'], { timeout: 30000, maxBuffer: 128 * 1024 })
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'deploy', name, archive, template, entryFile], { timeout: 12 * 60 * 1000, maxBuffer: 256 * 1024 })
    res.json({ ...JSON.parse(stdout.trim().split('\n').at(-1)), repository, branch: branch || null })
  } catch (error) {
    res.status(500).json({ error: readableDeploymentError(error) })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(archive, { force: true })
  }
})

const validProjectPath = value => {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (normalized.length > 240 || normalized.split('/').some(part => part === '..' || part === '')) return null
  return normalized || '.'
}
const guestCommand = async (name, command, timeout = 35000) => {
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'exec', name, encoded], { timeout, maxBuffer: 512 * 1024 })
    return JSON.parse(stdout)
  } catch (error) {
    const lines = String(error.stderr || error.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    const detail = lines.at(-1)?.replace(/^RuntimeError:\s*/, '')
    throw new Error(detail || 'The guest command failed.')
  }
}
const fileScope = value => ['user', 'project', 'minecraft'].includes(value) ? value : 'project'
const scopeRoot = scope => scope === 'user' ? '/home/vyron/files' : scope === 'minecraft' ? '/srv/minecraft' : '/srv/vyron/app'
app.get('/v1/vms/:name/files', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.query.path || '.'), scope = fileScope(req.query.scope)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative) return res.status(400).json({ error: 'Invalid project path.' })
  const encoded = Buffer.from(relative).toString('base64')
  const root = scopeRoot(scope)
  const command = `mkdir -p '${root}'\nchown vyron:vyron '${root}'\npython3 - <<'PY'\nimport base64,json,pathlib\nroot=pathlib.Path('${root}').resolve(); rel=base64.b64decode('${encoded}').decode(); target=(root/rel).resolve()\nif target != root and root not in target.parents: raise SystemExit('Invalid path')\nif not target.is_dir(): raise SystemExit('Directory not found')\nitems=[]\nfor p in sorted(target.iterdir(),key=lambda x:(not x.is_dir(),x.name.lower()))[:500]:\n if p.name != '.git': items.append({'name':p.name,'path':str(p.relative_to(root)),'type':'directory' if p.is_dir() else 'file','size':p.stat().st_size if p.is_file() else None})\nprint(json.dumps(items))\nPY`
  try {
    const result = await guestCommand(name, command)
    if (result.exitCode) throw new Error(result.stderr || 'Could not list project files.')
    res.json({ path: relative, files: JSON.parse(result.stdout) })
  } catch (error) { res.status(503).json({ error: error.message }) }
})
app.get('/v1/vms/:name/file', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.query.path), scope = fileScope(req.query.scope)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative || relative === '.') return res.status(400).json({ error: 'Invalid project path.' })
  const encoded = Buffer.from(relative).toString('base64')
  const root = scopeRoot(scope)
  const command = `python3 - <<'PY'\nimport base64,json,pathlib\nroot=pathlib.Path('${root}').resolve(); rel=base64.b64decode('${encoded}').decode(); target=(root/rel).resolve()\nif root not in target.parents or not target.is_file(): raise SystemExit('File not found')\ndata=target.read_bytes()\nif len(data)>65536 or b'\\0' in data: raise SystemExit('Only text files up to 64 KB can be edited')\nprint(json.dumps({'path':rel,'content':data.decode('utf-8')}))\nPY`
  try {
    const result = await guestCommand(name, command)
    if (result.exitCode) throw new Error(result.stderr || 'Could not read project file.')
    res.json(JSON.parse(result.stdout))
  } catch (error) { res.status(503).json({ error: error.message }) }
})
app.put('/v1/vms/:name/file', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.body.path), content = String(req.body.content ?? ''), scope = fileScope(req.body.scope)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative || relative === '.') return res.status(400).json({ error: 'Invalid project path.' })
  if (Buffer.byteLength(content) > 49152) return res.status(413).json({ error: 'Text files are limited to 48 KB.' })
  const encodedPath = Buffer.from(relative).toString('base64'), encodedContent = Buffer.from(content).toString('base64')
  const root = scopeRoot(scope)
  const command = `python3 - <<'PY'\nimport base64,pathlib\nroot=pathlib.Path('${root}').resolve(); rel=base64.b64decode('${encodedPath}').decode(); target=(root/rel).resolve()\nif root not in target.parents: raise SystemExit('Invalid path')\ntarget.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(base64.b64decode('${encodedContent}'))\nPY\nchown -R ${scope === 'minecraft' ? 'root:root' : 'vyron:vyron'} '${root}'\n${scope === 'project' ? 'if systemctl is-enabled vyron-node >/dev/null 2>&1; then systemctl restart vyron-node; fi' : scope === 'minecraft' ? 'if systemctl is-enabled vyron-minecraft >/dev/null 2>&1; then systemctl restart vyron-minecraft; fi' : ''}`
  try {
    const result = await guestCommand(name, command, 60000)
    if (result.exitCode) throw new Error(result.stderr || 'Could not save project file.')
    res.json({ path: relative, saved: true, restarted: scope !== 'user' })
  } catch (error) { res.status(503).json({ error: error.message }) }
})

app.post('/v1/vms/:name/files/folder', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.body.path), scope = fileScope(req.body.scope)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative || relative === '.') return res.status(400).json({ error: 'Invalid folder path.' })
  const encodedPath = Buffer.from(relative).toString('base64')
  const root = scopeRoot(scope)
  const command = `python3 - <<'PY'\nimport base64,json,pathlib\nroot=pathlib.Path('${root}').resolve(); rel=base64.b64decode('${encodedPath}').decode(); target=(root/rel).resolve()\nif root not in target.parents: raise SystemExit('Invalid path')\nalready_exists=target.exists()\nif already_exists and not target.is_dir(): raise SystemExit('A file already exists at this path')\ntarget.mkdir(parents=True,exist_ok=True)\nprint(json.dumps({'path':rel,'created':not already_exists}))\nPY\nchown -R ${scope === 'minecraft' ? 'root:root' : 'vyron:vyron'} '${root}'`
  try {
    const result = await guestCommand(name, command)
    if (result.exitCode) throw new Error(result.stderr || 'Could not create folder.')
    res.status(201).json(JSON.parse(result.stdout))
  } catch (error) { res.status(503).json({ error: error.message }) }
})

app.delete('/v1/vms/:name/file', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.body.path), scope = fileScope(req.body.scope)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative || relative === '.') return res.status(400).json({ error: 'Invalid file or folder path.' })
  const encodedPath = Buffer.from(relative).toString('base64')
  const root = scopeRoot(scope)
  const command = `python3 - <<'PY'\nimport base64,json,pathlib,shutil\nroot=pathlib.Path('${root}').resolve(); rel=base64.b64decode('${encodedPath}').decode(); target=(root/rel).resolve()\nif root not in target.parents: raise SystemExit('Invalid path')\nif not target.exists(): raise SystemExit('File or folder not found')\nkind='directory' if target.is_dir() else 'file'\nif target.is_dir(): shutil.rmtree(target)\nelse: target.unlink()\nprint(json.dumps({'path':rel,'removed':True,'type':kind}))\nPY\n${scope === 'project' ? 'if systemctl is-enabled vyron-node >/dev/null 2>&1; then systemctl restart vyron-node; fi' : scope === 'minecraft' ? 'if systemctl is-enabled vyron-minecraft >/dev/null 2>&1; then systemctl restart vyron-minecraft; fi' : ''}`
  try {
    const result = await guestCommand(name, command, 60000)
    if (result.exitCode) throw new Error(result.stderr || 'Could not remove file or folder.')
    res.json({ ...JSON.parse(result.stdout), restarted: scope !== 'user' })
  } catch (error) { res.status(503).json({ error: error.message }) }
})

app.post('/v1/vms/:name/files/upload/start', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.body.path), scope = fileScope(req.body.scope)
  const uploadId = String(req.body.uploadId || ''), size = Number(req.body.size)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative || relative === '.' || !/^[a-f0-9-]{36}$/i.test(uploadId)) return res.status(400).json({ error: 'Invalid upload request.' })
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_UPLOAD) return res.status(413).json({ error: 'Files are limited to 1 GB.' })
  if (fileUploads.has(uploadId)) return res.status(409).json({ error: 'This upload already exists.' })
  const temporary = `/tmp/vyron-file-${uploadId}.bin`
  try {
    fs.writeFileSync(temporary, Buffer.alloc(0), { mode: 0o600, flag: 'wx' })
    fileUploads.set(uploadId, { id: uploadId, name, relative, scope, size, written: 0, temporary, updatedAt: Date.now() })
    res.status(201).json({ uploadId, size })
  } catch (error) { res.status(503).json({ error: error.message }) }
})

app.post('/v1/vms/:name/files/upload/chunk', async (req, res) => {
  const uploadId = String(req.body.uploadId || ''), offset = Number(req.body.offset), data = String(req.body.data || '')
  const upload = fileUploads.get(uploadId)
  if (!upload || upload.name !== req.params.name) return res.status(404).json({ error: 'Upload session not found.' })
  if (!Number.isSafeInteger(offset) || offset !== upload.written || !data || data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return res.status(400).json({ error: 'Invalid upload chunk.' })
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > MAX_UPLOAD_CHUNK || upload.written + bytes.length > upload.size) return res.status(413).json({ error: 'Invalid upload chunk size.' })
  try {
    fs.appendFileSync(upload.temporary, bytes)
    upload.written += bytes.length; upload.updatedAt = Date.now()
    res.json({ uploadId, received: upload.written, size: upload.size })
  } catch (error) { res.status(503).json({ error: error.message }) }
})

app.post('/v1/vms/:name/files/upload/complete', async (req, res) => {
  const uploadId = String(req.body.uploadId || ''), upload = fileUploads.get(uploadId)
  if (!upload || upload.name !== req.params.name) return res.status(404).json({ error: 'Upload session not found.' })
  if (upload.written !== upload.size) return res.status(409).json({ error: `Upload is incomplete (${upload.written} of ${upload.size} bytes).` })
  try {
    const encodedPath = Buffer.from(upload.relative).toString('base64')
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'upload', upload.name, upload.temporary, upload.scope, encodedPath], { timeout: 300000, maxBuffer: 128 * 1024 })
    res.status(201).json(JSON.parse(stdout.trim().split('\n').at(-1)))
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
  finally { fileUploads.delete(uploadId); fs.rmSync(upload.temporary, { force: true }) }
})

app.delete('/v1/vms/:name/files/upload/:uploadId', (req, res) => {
  const upload = fileUploads.get(req.params.uploadId)
  if (upload?.name === req.params.name) { fileUploads.delete(req.params.uploadId); fs.rmSync(upload.temporary, { force: true }) }
  res.json({ cancelled: true })
})

setInterval(() => {
  const expiredBefore = Date.now() - 30 * 60_000
  for (const [id, upload] of fileUploads) if (upload.updatedAt < expiredBefore) { fileUploads.delete(id); fs.rmSync(upload.temporary, { force: true }) }
}, 10 * 60_000).unref()

app.post('/v1/vms/:name/files/upload', async (req, res) => {
  const name = req.params.name, relative = validProjectPath(req.body.path), data = String(req.body.data || ''), scope = fileScope(req.body.scope)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !relative || relative === '.') return res.status(400).json({ error: 'Invalid upload path.' })
  if (!data || data.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return res.status(413).json({ error: 'Files are limited to 10 MB.' })
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'Files are limited to 10 MB.' })
  const upload = `/tmp/vyron-file-${crypto.randomUUID()}.bin`
  try {
    fs.writeFileSync(upload, bytes, { mode: 0o600, flag: 'wx' })
    const encodedPath = Buffer.from(relative).toString('base64')
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'upload', name, upload, scope, encodedPath], { timeout: 120000, maxBuffer: 128 * 1024 })
    res.status(201).json(JSON.parse(stdout.trim().split('\n').at(-1)))
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
  finally { fs.rmSync(upload, { force: true }) }
})

const paperUserAgent = 'VyronHosting/1.0 (https://vyronhosting.com)'
const paperDownload = async version => {
  const response = await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`, { headers: { 'User-Agent': paperUserAgent } })
  if (!response.ok) throw new Error(`Paper download service returned HTTP ${response.status}`)
  const body = await response.json()
  const builds = Array.isArray(body) ? body : body.builds || []
  const stable = builds.filter(build => String(build.channel || '').toUpperCase() === 'STABLE')
  const build = (stable.length ? stable : builds).sort((a, b) => Number(b.id || b.build || 0) - Number(a.id || a.build || 0))[0]
  const download = build?.downloads?.['server:default'] || build?.downloads?.server || build?.downloads?.application
  const url = typeof download === 'string' ? download : download?.url
  if (!url || !url.startsWith('https://')) throw new Error(`No Paper build is available for Minecraft ${version}`)
  return url
}
const routeFor = async name => {
  const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'route', name], { timeout: 10000 })
  return JSON.parse(stdout)
}
const rconPacket = (id, type, value = '') => {
  const payload = Buffer.from(value, 'utf8'), packet = Buffer.alloc(14 + payload.length)
  packet.writeInt32LE(10 + payload.length, 0); packet.writeInt32LE(id, 4); packet.writeInt32LE(type, 8); payload.copy(packet, 12)
  return packet
}
const rcon = async (name, password, command) => {
  const route = await routeFor(name)
  if (route.status !== 'running' || !route.ip) throw new Error('Minecraft node is not reachable yet.')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: route.ip, port: 25575 }), chunks = []
    let authenticated = false, settled = false
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value) }
    socket.setTimeout(6000, () => finish(new Error('Minecraft is still starting.')))
    socket.on('error', error => finish(error))
    socket.on('connect', () => socket.write(rconPacket(71, 3, password)))
    socket.on('data', data => {
      chunks.push(data); const buffer = Buffer.concat(chunks)
      let offset = 0
      while (offset + 4 <= buffer.length) {
        const length = buffer.readInt32LE(offset)
        if (offset + length + 4 > buffer.length) break
        const id = buffer.readInt32LE(offset + 4), text = buffer.subarray(offset + 12, offset + length + 2).toString('utf8')
        offset += length + 4
        if (!authenticated) {
          if (id === -1) return finish(new Error('Minecraft console authentication failed.'))
          authenticated = true; chunks.length = 0; socket.write(rconPacket(72, 2, command)); return
        }
        if (id === 72) return finish(null, text)
      }
    })
  })
}

const minecraftApi = async (name, method, apiPath, payload = null, timeout = 35000) => {
  const body64 = payload ? Buffer.from(JSON.stringify(payload)).toString('base64') : ''
  const command = payload
    ? `printf '%s' '${body64}' | base64 -d | curl -sS --fail-with-body -X '${method}' -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:25580${apiPath}'`
    : `curl -sS --fail-with-body -X '${method}' 'http://127.0.0.1:25580${apiPath}'`
  const result = await guestCommand(name, command, timeout)
  if (result.exitCode) throw new Error(result.stdout || result.stderr || 'Minecraft API is unavailable.')
  return JSON.parse(result.stdout)
}
app.post('/v1/vms/:name/minecraft/setup', async (req, res) => {
  const name = req.params.name, version = String(req.body.version || '1.21.11'), loader = String(req.body.loader || 'paper').toLowerCase()
  const maxPlayers = Math.min(200, Math.max(1, Number(req.body.maxPlayers) || 20)), ram = Math.max(1, Number(req.body.ram) || 2)
  const motd = String(req.body.motd || 'A Vyron Minecraft Server').replace(/[\r\n=]/g, ' ').slice(0, 80)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !['paper', 'vanilla', 'purpur', 'fabric', 'folia', 'forge'].includes(loader) || !/^1\.(?:20|21)(?:\.\d+)?$/.test(version)) return res.status(400).json({ error: 'Invalid Minecraft configuration.' })
  try {
    const service = `[Unit]\nDescription=Vyron Minecraft Runtime API\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nUser=root\nWorkingDirectory=/srv/minecraft\nExecStart=/usr/bin/node /opt/vyron-minecraft/runtime.cjs\nRestart=always\nRestartSec=4\nKillMode=control-group\nTimeoutStopSec=90\n\n[Install]\nWantedBy=multi-user.target\n`
    const command = `set -e\nexport DEBIAN_FRONTEND=noninteractive\ncloud-init status --wait >/dev/null 2>&1 || true\napt-get update -qq\napt-get install -y -qq openjdk-17-jre-headless openjdk-21-jre-headless curl ca-certificates nodejs\ninstall -d -m 700 /opt/vyron-minecraft\ninstall -d /srv/minecraft\nprintf '%s' '${Buffer.from(minecraftRuntime).toString('base64')}' | base64 -d > /opt/vyron-minecraft/runtime.cjs\nprintf '%s' '${Buffer.from(service).toString('base64')}' | base64 -d > /etc/systemd/system/vyron-minecraft.service\nsystemctl disable --now minecraft.service >/dev/null 2>&1 || true\nsystemctl daemon-reload\nsystemctl enable vyron-minecraft.service\nsystemctl restart vyron-minecraft.service\nfor i in $(seq 1 30); do curl -fsS http://127.0.0.1:25580/health >/dev/null && exit 0; sleep 1; done\nexit 1`
    const result = await guestCommand(name, command, 8 * 60 * 1000)
    if (result.exitCode) throw new Error(result.stderr || 'Minecraft installation failed.')
    const existing = await minecraftApi(name, 'GET', '/api/servers')
    if (!existing.servers?.length) await minecraftApi(name, 'POST', '/api/servers', { id: 'primary', name, loader, mcVersion: version, port: 25565, ramGb: ram, autoStart: true, maxPlayers, motd })
    await minecraftApi(name, 'POST', '/api/servers/primary/action', { action: 'start' })
    const deadline = Date.now() + (loader === 'forge' ? 12 : 4) * 60 * 1000
    let consoleState = null
    while (Date.now() < deadline) {
      consoleState = await minecraftApi(name, 'GET', '/api/servers/primary/console?limit=30')
      if (consoleState.status === 'running') break
      if (consoleState.status === 'failed') throw new Error(consoleState.lines?.at(-1)?.text || `${loader} failed to start.`)
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
    if (consoleState?.status !== 'running') throw new Error(`${loader} did not become ready in time.`)
    res.status(201).json({ status: 'running', loader, version, port: 25565, maxPlayers })
  } catch (error) { res.status(503).json({ error: error.message }) }
})
app.get('/v1/vms/:name/minecraft/status', async (req, res) => {
  try {
    const [list, players] = await Promise.all([minecraftApi(req.params.name, 'GET', '/api/servers'), minecraftApi(req.params.name, 'GET', '/api/servers/primary/players')])
    const server = list.servers?.[0]; if (!server) throw new Error('Minecraft server has not been created yet.')
    res.json({ status: server.status, playersOnline: players.count || 0, maxPlayers: players.maxPlayers || server.maxPlayers, players: (players.online || []).map(player => player.name), version: server.mcVersion, loader: server.loader, api: 'vyron-serverpanel' })
  } catch (error) { res.status(503).json({ error: error.message }) }
})
const extensionFolder = loader => ['paper', 'purpur', 'folia'].includes(loader) ? 'plugins' : ['fabric', 'forge'].includes(loader) ? 'mods' : null
const safeExtensionFile = value => /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,159}\.jar$/.test(String(value || '')) ? String(value) : null
app.get('/v1/vms/:name/minecraft/extensions', async (req, res) => {
  const name = req.params.name, loader = String(req.query.loader || '').toLowerCase(), folder = extensionFolder(loader)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !folder) return res.status(400).json({ error: 'This Minecraft loader does not support managed extensions.' })
  try {
    const result = await guestCommand(name, `install -d '/srv/minecraft/${folder}'\nfind '/srv/minecraft/${folder}' -maxdepth 1 -type f -name '*.jar' -printf '%f\\n' | sort`, 30000)
    if (result.exitCode) throw new Error(result.stderr || 'Could not inspect installed extensions.')
    res.json({ folder, files: result.stdout.split(/\r?\n/).filter(Boolean).map(filename => ({ filename })) })
  } catch (error) { res.status(503).json({ error: error.message }) }
})
app.post('/v1/vms/:name/minecraft/extensions/install', async (req, res) => {
  const name = req.params.name, loader = String(req.body.loader || '').toLowerCase(), folder = extensionFolder(loader), files = Array.isArray(req.body.files) ? req.body.files.slice(0, 20) : []
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !folder || !files.length) return res.status(400).json({ error: 'Invalid extension installation request.' })
  const installed = [], temporary = []
  try {
    for (const item of files) {
      const filename = safeExtensionFile(item.filename), expectedHash = String(item.sha512 || '').toLowerCase(), parsed = new URL(String(item.url || ''))
      if (!filename || !/^[a-f0-9]{128}$/.test(expectedHash) || parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.modrinth.com') throw new Error('Modrinth returned an unsafe extension file.')
      const response = await fetch(parsed, { headers: { 'User-Agent': 'VyronHosting/1.0 (https://vyronhosting.com)' }, redirect: 'follow' })
      if (!response.ok || new URL(response.url).hostname !== 'cdn.modrinth.com' || !response.body) throw new Error(`Could not download ${filename} from Modrinth.`)
      const declared = Number(response.headers.get('content-length') || 0), limit = 100 * 1024 * 1024
      if (declared > limit) throw new Error(`${filename} is larger than 100 MB.`)
      const upload = `/tmp/vyron-file-${crypto.randomUUID()}.bin`, hash = crypto.createHash('sha512'); temporary.push(upload)
      let size = 0
      const guard = new Transform({ transform(chunk, _, callback) { size += chunk.length; if (size > limit) return callback(new Error(`${filename} is larger than 100 MB.`)); hash.update(chunk); callback(null, chunk) } })
      await pipeline(Readable.fromWeb(response.body), guard, fs.createWriteStream(upload, { flags: 'wx', mode: 0o600 }))
      if (hash.digest('hex') !== expectedHash) throw new Error(`${filename} failed its SHA-512 integrity check.`)
      const encodedPath = Buffer.from(`${folder}/${filename}`).toString('base64')
      const result = await run('sudo', ['/usr/local/sbin/vyron-provision', 'upload', name, upload, 'minecraft', encodedPath], { timeout: 120000, maxBuffer: 128 * 1024 })
      JSON.parse(result.stdout.trim().split('\n').at(-1)); installed.push({ filename, size })
    }
    await minecraftApi(name, 'POST', '/api/servers/primary/action', { action: 'stop' }, 90000)
    const restart = await guestCommand(name, 'systemctl restart vyron-minecraft', 90000)
    if (restart.exitCode) throw new Error(restart.stderr || 'Installed files, but Minecraft could not be restarted.')
    res.status(201).json({ installed, folder, restarted: true })
  } catch (error) { res.status(503).json({ error: error.stderr?.trim() || error.message }) }
  finally { for (const file of temporary) fs.rmSync(file, { force: true }) }
})
app.delete('/v1/vms/:name/minecraft/extensions/:filename', async (req, res) => {
  const name = req.params.name, loader = String(req.body.loader || '').toLowerCase(), folder = extensionFolder(loader), filename = safeExtensionFile(req.params.filename)
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name) || !folder || !filename) return res.status(400).json({ error: 'Invalid extension.' })
  const encoded = Buffer.from(filename).toString('base64')
  try {
    await minecraftApi(name, 'POST', '/api/servers/primary/action', { action: 'stop' }, 90000)
    const result = await guestCommand(name, `name=$(printf '%s' '${encoded}' | base64 -d)\nrm -f -- "/srv/minecraft/${folder}/$name"\nsystemctl restart vyron-minecraft`, 90000)
    if (result.exitCode) throw new Error(result.stderr || 'Could not remove extension.')
    res.json({ removed: filename, restarted: true })
  } catch (error) { res.status(503).json({ error: error.message }) }
})
app.get('/v1/vms/:name/minecraft/logs', async (req, res) => {
  try { const result = await minecraftApi(req.params.name, 'GET', `/api/servers/primary/console?limit=${Math.min(400, Math.max(20, Number(req.query.lines) || 180))}`); res.json({ output: (result.lines || []).map(line => `[${line.at}] ${line.text}`).join('\n'), status: result.status, api: 'vyron-serverpanel' }) }
  catch (error) { res.status(503).json({ error: error.message }) }
})
app.post('/v1/vms/:name/minecraft/command', async (req, res) => {
  const command = String(req.body.command || '').trim()
  if (!command || command.length > 300) return res.status(400).json({ error: 'Command must be 1–300 characters.' })
  try { const result = await minecraftApi(req.params.name, 'POST', '/api/servers/primary/console/command', { command }); res.json({ ...result, output: result.ok ? 'Command sent through server stdin.' : '' }) }
  catch (error) { res.status(503).json({ error: error.message }) }
})
app.post('/v1/vms/:name/minecraft/:action', async (req, res) => {
  if (!['start', 'stop', 'restart'].includes(req.params.action)) return res.status(400).json({ error: 'Invalid Minecraft action.' })
  try { const result = await minecraftApi(req.params.name, 'POST', '/api/servers/primary/action', { action: req.params.action }, 90000); res.json({ status: result.server?.status || (req.params.action === 'stop' ? 'stopped' : 'starting'), server: result.server }) }
  catch (error) { res.status(503).json({ error: error.message }) }
})

app.delete('/v1/vms/:name', async (req, res) => {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(req.params.name)) return res.status(400).json({ error: 'Invalid node name' })
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', 'delete', req.params.name], { timeout: 60000 })
    res.json(JSON.parse(stdout))
  } catch (error) { res.status(500).json({ error: error.stderr?.trim() || error.message }) }
})

app.post('/v1/vms/:name/:action', async (req, res) => {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(req.params.name)) return res.status(400).json({ error: 'Invalid node name' })
  if (!['start', 'stop'].includes(req.params.action)) return res.status(400).json({ error: 'Invalid action' })
  try {
    const { stdout } = await run('sudo', ['/usr/local/sbin/vyron-provision', req.params.action, req.params.name], { timeout: 60000 })
    await run('sudo', ['/usr/local/sbin/vyron-provision', 'gateway-sync', req.params.name], { timeout: 30000, maxBuffer: 128 * 1024 })
    res.json(JSON.parse(stdout))
  } catch (error) { res.status(500).json({ error: error.stderr?.trim() || error.message }) }
})

const port = Number(process.env.PORT || 8790)
const agentServer = http.createServer(app)
const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
agentServer.on('upgrade', (req, socket, head) => {
  let pathname
  try { pathname = new URL(req.url, 'http://agent.local').pathname } catch { socket.destroy(); return }
  const match = pathname.match(/^\/v1\/vms\/([a-z][a-z0-9-]{2,31})\/terminal$/)
  if (!match || !authorizedAgentRequest(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
  terminalSockets.handleUpgrade(req, socket, head, ws => terminalSockets.emit('connection', ws, req, match[1]))
})
terminalSockets.on('connection', (ws, _req, name) => {
  let terminal
  try {
    terminal = pty.spawn('sudo', ['/usr/local/sbin/vyron-provision', 'console', name], {
      name: 'xterm-256color', cols: 120, rows: 34, cwd: '/tmp', env: { ...process.env, TERM: 'xterm-256color', LANG: 'C.UTF-8' }
    })
  } catch (error) { ws.send(JSON.stringify({ type: 'error', message: error.message })); ws.close(1011); return }
  ws.send(JSON.stringify({ type: 'ready', name }))
  let autoLogin = null, loginStage = 'waiting', promptBuffer = '', loginWakeTimers = []
  const wakeLoginPrompt = () => {
    if (!autoLogin || loginStage !== 'waiting') return
    terminal.write('\r')
  }
  const scheduleLoginWakeups = () => {
    for (const timer of loginWakeTimers) clearTimeout(timer)
    loginWakeTimers = [150, 700, 1800, 3500].map(delay => setTimeout(wakeLoginPrompt, delay))
  }
  const tryAutoLogin = () => {
    if (!autoLogin || loginStage === 'done') return
    const visible = promptBuffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
    if (loginStage === 'waiting' && /(?:^|\n)[^\n]*login:\s*$/i.test(visible)) {
      terminal.write(`${autoLogin.username}\r`); loginStage = 'password'; promptBuffer = ''; return
    }
    if (loginStage === 'password' && /password:\s*$/i.test(visible)) {
      terminal.write(`${autoLogin.password}\r`); loginStage = 'done'; promptBuffer = ''
    }
  }
  const output = terminal.onData(data => {
    promptBuffer = `${promptBuffer}${data}`.slice(-2048)
    tryAutoLogin()
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }))
  })
  const exit = terminal.onExit(({ exitCode }) => { if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'exit', exitCode })); ws.close() } })
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString())
      if (message.type === 'autologin' && /^[a-z_][a-z0-9_-]{0,63}$/i.test(String(message.username || '')) && typeof message.password === 'string' && message.password.length > 0 && message.password.length <= 512) {
        autoLogin = { username: message.username, password: message.password }; tryAutoLogin(); scheduleLoginWakeups()
      }
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 8192) terminal.write(message.data)
      if (message.type === 'resize') terminal.resize(Math.max(20, Math.min(300, Number(message.cols) || 120)), Math.max(5, Math.min(120, Number(message.rows) || 34)))
    } catch {}
  })
  let closed = false
  const close = () => { if (closed) return; closed = true; for (const timer of loginWakeTimers) clearTimeout(timer); output.dispose(); exit.dispose(); try { terminal.kill() } catch {} }
  ws.once('close', close); ws.once('error', close)
})
agentServer.listen(port, '127.0.0.1', () => console.log(`Vyron Agent listening on 127.0.0.1:${port}`))
publicRouter.listen(Number(process.env.PUBLIC_ROUTER_PORT || 8800), '127.0.0.1', () => console.log('Vyron public node router listening on 127.0.0.1:8800'))
