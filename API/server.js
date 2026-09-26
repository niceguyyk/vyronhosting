import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import pg from 'pg'
import Stripe from 'stripe'
import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createVyronMcpServer } from './mcp.js'

const app = express()
const terminalTickets = new Map()
app.disable('x-powered-by')
app.set('trust proxy', 1)
const allowedOrigins = new Set((process.env.VYRON_ALLOWED_ORIGINS || 'https://app.vyronhosting.com,https://vyronhosting.com').split(',').map(value => value.trim()).filter(Boolean))
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ credentials: true, origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)) }))
app.use(express.json({ limit: '30mb', verify: (req, _, buffer) => { req.rawBody = Buffer.from(buffer) } }))
app.use('/v1/', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }))
app.use('/v1/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }))
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const origin = req.headers.origin
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'Request origin is not allowed.' })
  next()
})

const DATA_DIR = process.env.VYRON_DATA_DIR || '/home/x1/.local/share/vyron'
const DATA_FILE = path.join(DATA_DIR, 'data.json')
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-gateway.json')
const ALERT_CONFIG_FILE = path.join(DATA_DIR, 'alert-delivery.json')
const PAYPAL_CONFIG_FILE = path.join(DATA_DIR, 'paypal-mode.json')
const readSecret = (file, env) => process.env[env] || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '')
const databaseUrl = fs.existsSync('/home/x1/.config/vyron/database-url') ? fs.readFileSync('/home/x1/.config/vyron/database-url', 'utf8').trim() : (process.env.DATABASE_URL || '')
const apiKey = readSecret('/home/x1/.config/vyron/api-key', 'VYRON_API_KEY')
const agentToken = readSecret('/home/x1/.config/vyron/agent-token', 'VYRON_AGENT_TOKEN')
const cloudflareToken = readSecret('/home/x1/.config/vyron/cloudflare-api-token', 'CLOUDFLARE_API_TOKEN')
const cloudflareEmail = readSecret('/home/x1/.config/vyron/cloudflare-api-email', 'CLOUDFLARE_API_EMAIL')
const cloudflareAccountId = readSecret('/home/x1/.config/vyron/cloudflare-account-id', 'CLOUDFLARE_ACCOUNT_ID')
const cloudflareTunnelId = readSecret('/home/x1/.config/vyron/cloudflare-tunnel-id', 'CLOUDFLARE_TUNNEL_ID')
const configuredCloudflareZoneId = readSecret('/home/x1/.config/vyron/cloudflare-zone-id', 'CLOUDFLARE_ZONE_ID')
const cloudflareTeamName = readSecret('/home/x1/.config/vyron/cloudflare-team-name', 'CLOUDFLARE_TEAM_NAME')
const turnstileSiteKey = readSecret('/home/x1/.config/vyron/turnstile-sitekey', 'TURNSTILE_SITE_KEY')
const turnstileSecret = readSecret('/home/x1/.config/vyron/turnstile-secret', 'TURNSTILE_SECRET_KEY')
const stripeSecretKey = readSecret('/home/x1/.config/vyron/stripe-test-secret-key', 'STRIPE_TEST_SECRET_KEY')
const stripePublishableKey = readSecret('/home/x1/.config/vyron/stripe-test-publishable-key', 'STRIPE_TEST_PUBLISHABLE_KEY')
const stripeWebhookSecret = readSecret('/home/x1/.config/vyron/stripe-test-webhook-secret', 'STRIPE_TEST_WEBHOOK_SECRET')
const stripeDiscordWebhookUrl = readSecret('/home/x1/.config/vyron/stripe-discord-webhook-url', 'STRIPE_DISCORD_WEBHOOK_URL')
const stripeTestConfigured = () => stripeSecretKey.startsWith('sk_test_') && stripePublishableKey.startsWith('pk_test_')
const stripe = stripeSecretKey.startsWith('sk_test_') ? new Stripe(stripeSecretKey) : null
const webauthnRpId = process.env.WEBAUTHN_RP_ID || 'app.vyronhosting.com'
const webauthnOrigin = process.env.WEBAUTHN_ORIGIN || `https://${webauthnRpId}`
const paypalMode = () => {
  try { return JSON.parse(fs.readFileSync(PAYPAL_CONFIG_FILE, 'utf8')).mode === 'live' ? 'live' : 'sandbox' }
  catch { return String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox' }
}
const paypalCredentials = (mode = paypalMode()) => {
  const prefix = mode === 'live' ? 'PAYPAL_LIVE' : 'PAYPAL_SANDBOX'
  const id = readSecret(`/home/x1/.config/vyron/paypal-${mode}-client-id`, `${prefix}_CLIENT_ID`) || (mode === 'sandbox' ? readSecret('/home/x1/.config/vyron/paypal-client-id', 'PAYPAL_CLIENT_ID') : '')
  const secret = readSecret(`/home/x1/.config/vyron/paypal-${mode}-client-secret`, `${prefix}_CLIENT_SECRET`) || (mode === 'sandbox' ? readSecret('/home/x1/.config/vyron/paypal-client-secret', 'PAYPAL_CLIENT_SECRET') : '')
  return { id, secret }
}
const paypalBaseUrl = mode => mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
const managedCnameTarget = process.env.VYRON_CUSTOM_DOMAIN_TARGET || 'customers.vyronhosting.com'
const publicGatewayIp = process.env.VYRON_PUBLIC_GATEWAY_IP || '94.16.108.132'
const publicGatewayHostname = process.env.VYRON_PUBLIC_GATEWAY_HOSTNAME || 'gateway.vyronhosting.com'
const privateNetwork = process.env.VYRON_PRIVATE_NETWORK || '192.168.122.0/24'
const agentUrl = process.env.AGENT_URL || 'http://127.0.0.1:8790'
const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const ADMIN_EMAILS = new Set((process.env.VYRON_ADMIN_EMAILS || 'niko.springer@outlook.com').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
const RESERVED_HOSTNAMES = new Set([
  'app', 'api', 'play', 'www', 'status', 'support', 'help', 'docs', 'mail', 'admin',
  'billing', 'payment', 'payments', 'checkout', 'account', 'accounts', 'auth', 'login',
  'register', 'dashboard', 'panel', 'console', 'customer', 'customers', 'gateway', 'ssh',
  'ftp', 'smtp', 'imap', 'pop', 'mx', 'ns1', 'ns2', 'dns', 'cdn', 'assets', 'static',
  'abuse', 'report', 'security', 'legal', 'privacy', 'terms', 'monitoring', 'uptime',
  'agent', 'agents', 'node', 'nodes', 'server', 'servers', 'root', 'system', 'cloud',
  'shop', 'store', 'webhook', 'webhooks', 'internal', 'dev', 'staging', 'test', 'beta',
  'official'
])
const plans = {
  mini: { id: 'mini', name: 'Mini', cpu: .5, ram: 2, disk: 20, price: 1 },
  basic: { id: 'basic', name: 'Basic', cpu: 1, ram: 4, disk: 100, price: 5 },
  pro: { id: 'pro', name: 'Pro', cpu: 2, ram: 6, disk: 200, price: 10 },
  enterprise: { id: 'enterprise', name: 'Enterprise', cpu: 4, ram: 12, disk: 500, price: 20 }
}
const coupons = {
  FREE26: { code: 'FREE26', percent: 20, active: true, firstMonthOnly: true, plans: ['mini', 'basic', 'pro', 'enterprise'] },
  FREE: { code: 'FREE', percent: 100, active: true, firstMonthOnly: false, plans: ['mini', 'basic', 'pro', 'enterprise'], allowedEmails: ['niko.springer@outlook.com'] },
  PAID3: { code: 'PAID3', percent: 100, active: true, firstMonthOnly: true, plans: ['mini', 'basic'], allowedEmails: ['francescomasi2013@outlook.com'] }
}
const upgradeRates = { cpu: 1, ram: 1.5, diskPer100Gb: 3 }
const defaultStatusConfig = () => ({ locations: [{ id: 'de-muc-1', name: 'Munich', country: 'Germany', city: 'Munich', region: 'EU Central', x: 51.35, y: 23.2, status: 'operational' }] })
const emptyDb = () => ({ users: [], sessions: [], apiTokens: [], passkeyChallenges: [], workspaces: [], orders: [], vms: [], domains: [], hostHistory: [], auditLogs: [], nodeEvents: [], supportTickets: [], referrals: [], statusIncidents: [], statusHistory: [], statusConfig: defaultStatusConfig(), couponGrants: [], abuseReports: [], adminNotifications: [], trafficSamples: [], aiChats: [], aiMemories: [] })
let db = emptyDb()
const { Pool } = pg
const database = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 30_000 }) : null

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 })
if (fs.existsSync(DATA_FILE)) {
  try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) } } catch { db = emptyDb() }
}
if (database) {
  await database.query('CREATE TABLE IF NOT EXISTS vyron_state (id SMALLINT PRIMARY KEY CHECK (id = 1), data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())')
  const stored = await database.query('SELECT data FROM vyron_state WHERE id = 1')
  if (stored.rows[0]?.data) db = { ...emptyDb(), ...stored.rows[0].data }
  else await database.query('INSERT INTO vyron_state (id, data) VALUES (1, $1::jsonb)', [JSON.stringify(db)])
}
let databaseSaveQueue = Promise.resolve()
const save = () => {
  const temp = `${DATA_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 })
  fs.renameSync(temp, DATA_FILE)
  if (database) {
    const snapshot = JSON.stringify(db)
    databaseSaveQueue = databaseSaveQueue.then(() => database.query('INSERT INTO vyron_state (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()', [snapshot])).catch(error => console.error('PostgreSQL save failed:', error.message))
  }
}
const DEFAULT_AI_CONFIG = { provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', model: 'openrouter/free', webSearch: true }
const readAiConfig = () => {
  try { return { ...DEFAULT_AI_CONFIG, ...JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8')) } } catch { return { ...DEFAULT_AI_CONFIG } }
}
const saveAiConfig = config => {
  const temp = `${AI_CONFIG_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(temp, AI_CONFIG_FILE)
}
const aiGatewayUrl = endpoint => `${String(endpoint || '').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`
const openRouterUrl = endpoint => `${String(endpoint || DEFAULT_AI_CONFIG.endpoint).replace(/\/+$/, '')}/chat/completions`
const webSearchRequested = value => /\b(search|find|look\s*up|latest|current|news|documentation|docs|price|weather|today|internet|web)\b/i.test(value)
const blockedAiRequest = value => /(?:steal|extract|dump|reveal).{0,24}(?:password|token|secret|credential)|(?:create|write|deploy|spread|run|execute|build|help.{0,12}with).{0,28}(?:malware|ransomware|botnet|ddos|phishing|credential stuffing|keylogger)|(?:bypass|evade).{0,24}(?:security|authentication|law enforcement)|(?:child sexual abuse|csam|human trafficking)|(?:make|build|buy).{0,18}(?:illegal weapon|bomb)|(?:doxx|swat).{0,20}(?:person|user|target)/i.test(value)
const safeDiagnosticCommand = command => {
  const value = clean(command).slice(0, 300)
  if (!value || /[;&|`$><\n\r]|\.\.|\/etc\/(?:shadow|passwd)|\/root\/\.ssh|id_rsa|authorized_keys|token|secret|password/i.test(value)) return null
  return /^(?:uptime|free(?:\s|$)|df(?:\s|$)|du(?:\s|$)|ls(?:\s|$)|pwd$|ps(?:\s|$)|ss(?:\s|$)|systemctl\s+(?:status|is-active)\s+[a-zA-Z0-9_.@-]+|journalctl\s+-u\s+[a-zA-Z0-9_.@-]+(?:\s+--no-pager)?(?:\s+-n\s+\d{1,3})?|tail\s+-n\s+\d{1,3}\s+\/(?:var\/log|srv\/minecraft\/logs)\/[a-zA-Z0-9_./-]+)$/i.test(value) ? value : null
}
const safeMinecraftCommand = command => {
  const value = clean(command).replace(/^\//, '').slice(0, 180)
  return /^(?:list|tps|version|save-all|whitelist\s+list|say\s+[a-zA-Z0-9 äöüÄÖÜß.,!?:_'"()-]{1,120})$/i.test(value) ? value : null
}
const pendingAiActions = new Map()
const aiRateLimits = new Map()
db.migrations ||= {}
if (!db.migrations.usageAlertsOptIn20260910) {
  for (const user of db.users) user.notifications = { ...(user.notifications || {}), usage: false }
  for (const vm of db.vms) delete vm.usageAlert
  db.migrations.usageAlertsOptIn20260910 = new Date().toISOString()
  save()
}
if (!db.migrations.accountApproval20260910) {
  // Approval is enforced for registrations created after this migration. All
  // accounts that already existed remain usable and are marked explicitly.
  for (const user of db.users) {
    user.approvedAt ||= user.createdAt || new Date().toISOString()
    user.approvedBy ||= 'migration'
  }
  db.migrations.accountApproval20260910 = new Date().toISOString()
  save()
}
let domainMigration = false
for (const domain of db.domains) {
  if (!domain.verificationToken) { domain.verificationToken = crypto.randomBytes(18).toString('hex'); domainMigration = true }
  if (domain.status === 'active' && !domain.verifiedAt) { domain.verifiedAt = domain.assignedAt || domain.createdAt; domainMigration = true }
  if (!domain.vmId && !domain.verifiedAt && domain.status !== 'pending_verification') { domain.status = 'pending_verification'; domainMigration = true }
}
if (domainMigration) save()
let workspaceMigration = false
for (const workspace of db.workspaces) {
  workspace.members ||= []
  workspace.invites ||= []
  const legacyMembers = new Set([workspace.ownerId, ...(workspace.userIds || [])].filter(Boolean))
  for (const userId of legacyMembers) {
    if (!workspace.members.some(member => member.userId === userId)) {
      workspace.members.push({ userId, role: userId === workspace.ownerId ? 'owner' : 'developer', joinedAt: workspace.createdAt || new Date().toISOString() })
      workspaceMigration = true
    }
  }
  if (!workspace.userIds?.includes(workspace.ownerId)) { workspace.userIds = [...new Set([workspace.ownerId, ...(workspace.userIds || [])])]; workspaceMigration = true }
}
if (workspaceMigration) save()
let reliabilityMigration = false
for (const vm of db.vms.filter(item => item.status !== 'deleted')) {
  if (!vm.desiredState) {
    vm.desiredState = vm.status === 'running' ? 'running' : 'stopped'
    reliabilityMigration = true
  }
}
if (reliabilityMigration) save()
for (const vm of db.vms.filter(v => v.deployment?.status === 'deploying' && (v.uploadPath || v.github?.repository))) vm.deployment.status = 'queued'
for (const vm of db.vms.filter(v => v.template === 'minecraft' && v.minecraft?.status === 'installing')) { vm.minecraft.status = 'queued'; vm.minecraft.stage = 'Resuming installation' }
const activeDeployments = new Set()
const activeSshCredentialRepairs = new Set()
const startNodeDeployment = vm => {
  if (activeDeployments.has(vm.id) || (!vm.uploadPath && !vm.github?.repository)) return
  activeDeployments.add(vm.id)
  const entryFile = vm.deployment?.entryFile || (vm.template === 'node' ? 'server.js' : 'index.html')
  vm.deployment.entryFile = entryFile
  vm.deployment.status = 'deploying'; delete vm.deployment.error; save()
  createNodeEvent(vm, 'deployment_started', 'Deployment started', vm.github?.repository ? `Pulling ${vm.github.repository}${vm.github.branch ? ` · ${vm.github.branch}` : ''}` : `Installing ${vm.deployment.fileName || 'uploaded project'}`)
  void (async () => {
    let removeUpload = false
    try {
      const result = vm.github?.repository
        ? await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/deploy-github`, { method: 'POST', body: JSON.stringify({ template: vm.template, repository: vm.github.repository, branch: vm.github.branch, entryFile }) })
        : await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/deploy`, { method: 'POST', body: JSON.stringify({ template: vm.template, archive: fs.readFileSync(vm.uploadPath).toString('base64'), entryFile }) })
      const dnsRecord = await ensureNodeHostname(vm)
      vm.deployment = { ...vm.deployment, status: 'deployed', port: result.port, appPort: result.appPort, deployedAt: new Date().toISOString() }
      vm.route = { type: 'web', hostname: vm.domain, targetPort: result.appPort || 80, proxyPort: result.port, status: 'active', cloudflareDnsId: dnsRecord?.id || null }
      createNodeEvent(vm, 'deployment_completed', 'Deployment completed', `${vm.deployment.fileName || vm.github?.repository || 'Application'} is live on port ${result.appPort || 80}.`)
      removeUpload = Boolean(vm.uploadPath)
    } catch (error) {
      const attempts = Number(vm.deployment.attempts || 0) + 1
      const retryable = /Guest Agent|not responding|not connected|timed out|cloud-init/i.test(error.message)
      vm.deployment = { ...vm.deployment, attempts, status: retryable && attempts < 6 ? 'queued' : 'failed', error: error.message }
      if (vm.deployment.status === 'failed') createNodeEvent(vm, 'deployment_failed', 'Deployment failed', error.message, 'critical')
      removeUpload = vm.deployment.status === 'failed'
    } finally {
      if (removeUpload) { fs.rmSync(vm.uploadPath, { force: true }); delete vm.uploadPath }
      activeDeployments.delete(vm.id)
      save()
    }
  })()
}
const clean = value => String(value || '').trim()
const createReferralCode = name => {
  const prefix = clean(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VYRON'
  let code
  do code = `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  while (db.users.some(user => user.referralCode === code))
  return code
}
const hashPassword = password => {
  const salt = crypto.randomBytes(16).toString('hex')
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`
}
const verifyPassword = (password, stored) => {
  const [salt, expected] = String(stored).split(':')
  if (!salt || !expected) return false
  const actual = crypto.scryptSync(password, salt, 64)
  const target = Buffer.from(expected, 'hex')
  return actual.length === target.length && crypto.timingSafeEqual(actual, target)
}
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32Encode = buffer => {
  let bits = '', output = ''
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0')
  for (let index = 0; index < bits.length; index += 5) output += base32Alphabet[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)]
  return output
}
const base32Decode = value => {
  const bits = String(value || '').toUpperCase().replace(/=+$/g, '').split('').map(character => base32Alphabet.indexOf(character).toString(2).padStart(5, '0')).join('')
  const bytes = []
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2))
  return Buffer.from(bytes)
}
const totpCode = (secret, counter = Math.floor(Date.now() / 30000)) => {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
}
const verifyTotp = (secret, code) => /^\d{6}$/.test(String(code || '')) && [-1, 0, 1].some(window => crypto.timingSafeEqual(Buffer.from(totpCode(secret, Math.floor(Date.now() / 30000) + window)), Buffer.from(String(code))))
const backupCodeHash = code => crypto.createHash('sha256').update(String(code || '').toUpperCase().replace(/\s+/g, '')).digest('hex')
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2))
const isAdmin = user => ADMIN_EMAILS.has(String(user?.email || '').toLowerCase())
const approvalStatus = user => isAdmin(user) || user?.approvedAt ? 'approved' : user?.approvalRejectedAt ? 'rejected' : 'pending'
const publicUser = user => ({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, isAdmin: isAdmin(user), banned: Boolean(user.bannedAt), approvalStatus: approvalStatus(user) })
const recordAudit = (req, action, target, detail = {}) => {
  db.auditLogs ||= []
  db.auditLogs.push({ id: crypto.randomUUID(), userId: req.user?.id || null, email: req.user?.email || null, action, target, detail, ip: req.ip, at: new Date().toISOString() })
  db.auditLogs = db.auditLogs.slice(-5000)
  save()
}
const safeAdminCommand = command => {
  const value = String(command || '').trim().slice(0, 2000)
  return value || null
}
const createSession = (req, res, userId) => {
  const token = crypto.randomBytes(32).toString('hex')
  db.sessions = db.sessions.filter(s => s.expiresAt > Date.now())
  db.sessions.push({ id: crypto.randomUUID(), tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), ip: req.ip, userAgent: clean(req.headers['user-agent']).slice(0, 180), expiresAt: Date.now() + SESSION_MS })
  save()
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  res.setHeader('Set-Cookie', `vyron_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`)
}
const createPasskeyChallenge = (userId, type, challenge) => {
  const now = Date.now()
  db.passkeyChallenges = (db.passkeyChallenges || []).filter(item => item.expiresAt > now)
  const item = { id: crypto.randomUUID(), userId, type, challenge, expiresAt: now + 5 * 60_000 }
  db.passkeyChallenges.push(item)
  save()
  return item
}
const consumePasskeyChallenge = (id, userId, type) => {
  const index = (db.passkeyChallenges || []).findIndex(item => item.id === id && item.userId === userId && item.type === type && item.expiresAt > Date.now())
  if (index < 0) return null
  const [item] = db.passkeyChallenges.splice(index, 1)
  save()
  return item
}
const storedWebAuthnCredential = passkey => ({ id: passkey.id, publicKey: Buffer.from(passkey.publicKey, 'base64'), counter: Number(passkey.counter || 0), transports: passkey.transports || [] })
const requireAuth = (req, res, next) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const apiTokenHash = bearer.startsWith('vyr_') ? crypto.createHash('sha256').update(bearer).digest('hex') : ''
  const apiToken = apiTokenHash && (db.apiTokens || []).find(item => item.tokenHash === apiTokenHash && !item.revokedAt)
  const tokenHash = crypto.createHash('sha256').update(cookies(req).vyron_session || '').digest('hex')
  const session = !apiToken && db.sessions.find(s => s.tokenHash === tokenHash && s.expiresAt > Date.now())
  const user = db.users.find(u => u.id === (apiToken?.userId || session?.userId))
  if (!user) return res.status(401).json({ error: 'Please sign in.' })
  if (user.bannedAt) {
    db.sessions = db.sessions.filter(item => item.userId !== user.id)
    save()
    res.setHeader('Set-Cookie', 'vyron_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    return res.status(403).json({ error: 'This account has been suspended. Contact Vyron support.' })
  }
  if (approvalStatus(user) !== 'approved') {
    db.sessions = db.sessions.filter(item => item.userId !== user.id)
    save()
    res.setHeader('Set-Cookie', 'vyron_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    return res.status(403).json({ error: approvalStatus(user) === 'rejected' ? 'This account request was not approved. Contact Vyron support if you think this is a mistake.' : 'Your account is waiting for administrator approval.', code: approvalStatus(user) === 'rejected' ? 'ACCOUNT_REJECTED' : 'ACCOUNT_PENDING' })
  }
  if (apiToken && req.method !== 'GET' && !apiToken.scopes?.includes('operate')) return res.status(403).json({ error: 'This API token has read-only access.' })
  if (apiToken) { apiToken.lastUsedAt = new Date().toISOString(); req.apiToken = apiToken }
  if (session) {
    session.id ||= crypto.randomUUID(); session.createdAt ||= new Date().toISOString(); session.lastUsedAt = new Date().toISOString()
    session.ip ||= req.ip; session.userAgent ||= clean(req.headers['user-agent']).slice(0, 180)
  }
  req.user = user; req.session = session; next()
}
const requireAdminKey = (req, res, next) => {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const valid = apiKey && supplied.length === apiKey.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(apiKey))
  return valid ? next() : res.status(401).json({ error: 'Unauthorized' })
}
const requireAdmin = (req, res, next) => isAdmin(req.user) ? next() : res.status(403).json({ error: 'Administrator access required.' })
const couponAllowedForUser = (code, userId) => {
  const coupon = coupons[code]
  if (!coupon) return false
  if (!coupon.allowedEmails?.length) return true
  const user = db.users.find(item => item.id === userId)
  return Boolean(user && coupon.allowedEmails.includes(String(user.email || '').toLowerCase()))
}
const couponAlreadyUsed = (code, userId) => (db.orders || []).some(order => order.userId === userId && order.coupon === code && order.status === 'paid')
const configuredLocations = () => db.statusConfig?.locations?.length ? db.statusConfig.locations : defaultStatusConfig().locations
const creationAvailability = () => {
  const locations = configuredLocations()
  const available = locations.some(location => location.status === 'operational')
  return { available, reason: available ? null : 'Node creation and start are paused while all server locations are under maintenance or experiencing an incident.', locations: locations.map(({ id, name, status }) => ({ id, name, status })) }
}
const requireStartAvailability = (res) => {
  const availability = creationAvailability()
  if (!availability.available) {
    res.status(503).json({ error: availability.reason, availability })
    return false
  }
  return true
}
const DEFAULT_ALERT_CONFIG = { provider: 'resend', recipient: 'niko.springer@outlook.com', from: 'Vyron Security <security@vyronhosting.com>', trafficThresholdMbps: 500, trafficWindowSamples: 2, cooldownMinutes: 30 }
const readAlertConfig = () => {
  try { return { ...DEFAULT_ALERT_CONFIG, ...JSON.parse(fs.readFileSync(ALERT_CONFIG_FILE, 'utf8')) } } catch { return { ...DEFAULT_ALERT_CONFIG } }
}
const saveAlertConfig = config => {
  const temp = `${ALERT_CONFIG_FILE}.tmp`
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(temp, ALERT_CONFIG_FILE)
}
const emailEscape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character])
const securityEmailHtml = (subject, text) => {
  const safeSubject = emailEscape(subject.replace(/^\[Vyron Security\]\s*/i, ''))
  const paragraphs = String(text || '').split(/\n{2,}/).map(value => `<p style="margin:0 0 14px;color:#a7a9b2;font-size:15px;line-height:1.65;">${emailEscape(value).replace(/\n/g, '<br>')}</p>`).join('')
  const timestamp = emailEscape(new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date()))
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safeSubject}</title></head><body style="margin:0;background:#0b0c0e;color:#f4f4f5;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">A new Vyron Security event requires your attention.</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0c0e;"><tr><td align="center" style="padding:42px 16px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;border:1px solid #2d2e34;border-radius:18px;background:#15161a;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.35);"><tr><td style="padding:22px 28px;border-bottom:1px solid #292a30;background:#121317;"><table role="presentation" width="100%"><tr><td><div style="display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:8px;background:#7d5bed;color:#fff;font-weight:800;transform:rotate(45deg);"><span style="display:inline-block;transform:rotate(-45deg);">V</span></div><span style="margin-left:12px;color:#f4f4f5;font-size:18px;font-weight:750;vertical-align:middle;">vyron</span></td><td align="right"><span style="display:inline-block;padding:7px 10px;border-radius:999px;background:#3a1f27;color:#ff8c9b;font-size:10px;font-weight:800;letter-spacing:.1em;">SECURITY ALERT</span></td></tr></table></td></tr><tr><td style="padding:34px 30px 28px;"><p style="margin:0 0 10px;color:#9a7cff;font-size:11px;font-weight:800;letter-spacing:.14em;">TRUST &amp; SAFETY</p><h1 style="margin:0 0 20px;color:#f5f5f6;font-size:26px;line-height:1.25;letter-spacing:-.03em;">${safeSubject}</h1><div style="padding:18px 18px 4px;border:1px solid #303139;border-radius:12px;background:#101115;">${paragraphs}</div><table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px;"><tr><td style="border-radius:9px;background:#7d5bed;"><a href="https://app.vyronhosting.com/admin" style="display:inline-block;padding:13px 18px;color:#fff;font-size:13px;font-weight:750;text-decoration:none;">Open Admin Panel &rarr;</a></td></tr></table><p style="margin:22px 0 0;color:#676a73;font-size:11px;line-height:1.55;">Received ${timestamp} Europe/Berlin<br>This automated alert was generated by Vyron Technologies infrastructure monitoring.</p></td></tr><tr><td style="padding:18px 30px;border-top:1px solid #292a30;background:#111216;color:#61646c;font-size:10px;">Vyron Technologies &middot; Security notification &middot; Do not forward sensitive report details.</td></tr></table></td></tr></table></body></html>`
}
const sendAlertEmail = async (subject, text) => {
  const config = readAlertConfig()
  if (!config.apiKey || !config.recipient || !config.from) return { sent: false, error: 'Email delivery is not configured.' }
  try {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: config.from, to: [config.recipient], subject, text, html: securityEmailHtml(subject, text) }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.message || `Email provider returned HTTP ${response.status}`)
    return { sent: true, providerId: body.id || null }
  } catch (error) { return { sent: false, error: error.message } }
}
const sendCustomerEmail = async (user, event) => {
  const config = readAlertConfig()
  if (!config.apiKey || !config.from || !user?.email) return { sent: false, skipped: true }
  try {
    const subject = `[Vyron] ${String(event.title || 'Service notification').slice(0, 140)}`
    const text = `${event.detail || ''}${event.nodeName ? `\n\nNode: ${event.nodeName}` : ''}\n\nOpen https://app.vyronhosting.com/app for details.`
    const html = securityEmailHtml(subject, text).replaceAll('https://app.vyronhosting.com/admin', 'https://app.vyronhosting.com/app').replace('Open Admin Panel', 'Open Vyron Dashboard')
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: config.from, to: [user.email], subject, text, html }) })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.message || `Email provider returned HTTP ${response.status}`)
    return { sent: true, providerId: body.id || null }
  } catch (error) { return { sent: false, error: error.message } }
}
const createAdminNotification = (kind, title, detail, meta = {}) => {
  db.adminNotifications ||= []
  const emailKinds = new Set(['domain_report', 'traffic_alert', 'security_alert', 'payment_failure'])
  const shouldEmail = emailKinds.has(kind)
  const notification = { id: crypto.randomUUID(), kind, title, detail, meta, readAt: null, createdAt: new Date().toISOString(), email: { status: shouldEmail ? 'queued' : 'skipped' } }
  db.adminNotifications.push(notification)
  db.adminNotifications = db.adminNotifications.slice(-1000)
  save()
  if (shouldEmail) void sendAlertEmail(`[Vyron Security] ${title}`, `${detail}\n\nOpen the Vyron Admin Panel to review this alert.`).then(result => {
    notification.email = { status: result.sent ? 'sent' : 'failed', ...result, at: new Date().toISOString() }
    save()
  })
  return notification
}
const agentRequest = async (urlPath, options = {}) => {
  const response = await fetch(`${agentUrl}${urlPath}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}`, ...options.headers } })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : {} }
  catch { body = { error: response.status === 404 ? 'The host agent does not support this operation yet.' : 'The host agent returned an invalid response.' } }
  if (!response.ok) throw Object.assign(new Error(body.error || 'Host agent is unavailable'), { status: response.status, body })
  return body
}
const paypalAccessToken = async (mode = paypalMode()) => {
  const credentials = paypalCredentials(mode)
  if (!credentials.id || !credentials.secret) throw Object.assign(new Error(`PayPal ${mode} checkout is not configured yet.`), { status: 503 })
  const response = await fetch(`${paypalBaseUrl(mode)}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.access_token) throw Object.assign(new Error(body.error_description || 'PayPal authentication failed.'), { status: 502 })
  return body.access_token
}
const paypalRequest = async (pathname, options = {}, mode = paypalMode()) => {
  const accessToken = await paypalAccessToken(mode)
  const response = await fetch(`${paypalBaseUrl(mode)}${pathname}`, { ...options, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': options.requestId || crypto.randomUUID(), ...options.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.details?.[0]?.description || body.message || 'PayPal request failed.'), { status: response.status >= 500 ? 502 : 400 })
  return body
}
const createPaypalOrder = (order, mode = paypalMode()) => paypalRequest('/v2/checkout/orders', {
  method: 'POST',
  requestId: `vyron-create-${order.id}`,
  body: JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [{ custom_id: order.id, description: order.kind === 'upgrade' ? `Vyron Hosting resource upgrade · ${order.nodeName}` : `Vyron Hosting ${order.plan} node`, amount: { currency_code: 'EUR', value: Number(order.total).toFixed(2) } }],
    payment_source: { paypal: { experience_context: { brand_name: 'Vyron Technologies', user_action: 'PAY_NOW', return_url: `https://app.vyronhosting.com/app?paypal_order=${encodeURIComponent(order.id)}`, cancel_url: 'https://app.vyronhosting.com/app?paypal_cancelled=1' } } }
  })
}, mode)
const createStripeCheckout = async (order, user) => {
  if (!stripeTestConfigured() || !stripe) throw Object.assign(new Error('Stripe test checkout is not configured yet.'), { status: 503 })
  const description = order.kind === 'upgrade' ? `Resource upgrade for ${order.nodeName}` : `${plans[order.plan]?.name || order.plan} node`
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ui_mode: 'elements',
    payment_method_types: ['paypal', 'card'],
    return_url: `https://app.vyronhosting.com/app?stripe_order=${encodeURIComponent(order.id)}&stripe_session={CHECKOUT_SESSION_ID}`,
    customer_email: user.email,
    client_reference_id: order.id,
    metadata: { orderId: order.id, userId: order.userId, kind: order.kind || 'node' },
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: Math.round(Number(order.total) * 100), product_data: { name: `Vyron Hosting · ${description}`, description: order.coupon ? `Coupon ${order.coupon} applied` : undefined } } }]
  }, { idempotencyKey: `vyron-checkout-${order.id}` })
  return session
}
const activeMinecraftSetups = new Set()
const startMinecraftSetup = vm => {
  if (activeMinecraftSetups.has(vm.id) || vm.template !== 'minecraft' || vm.status !== 'running' || vm.minecraft?.status !== 'queued') return
  activeMinecraftSetups.add(vm.id)
  vm.minecraft.status = 'installing'; vm.minecraft.stage = 'Installing Java 21'; delete vm.minecraft.error; save()
  void (async () => {
    const stageTimers = [
      setTimeout(() => { if (activeMinecraftSetups.has(vm.id)) { vm.minecraft.stage = `Resolving ${vm.minecraft.loader} ${vm.minecraft.version}`; save() } }, 8000),
      setTimeout(() => { if (activeMinecraftSetups.has(vm.id)) { vm.minecraft.stage = `Downloading ${vm.minecraft.loader}`; save() } }, 20000),
      setTimeout(() => { if (activeMinecraftSetups.has(vm.id)) { vm.minecraft.stage = 'Starting Minecraft server'; save() } }, 45000)
    ]
    try {
      const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/setup`, { method: 'POST', body: JSON.stringify({ loader: vm.minecraft.loader, version: vm.minecraft.version, ram: vm.ram, maxPlayers: vm.minecraft.maxPlayers, motd: vm.minecraft.motd, rconPassword: vm.minecraft.rconPassword }) })
      vm.minecraft = { ...vm.minecraft, ...result, status: result.status || 'starting', stage: result.status === 'running' ? 'Ready to play' : `Starting ${vm.minecraft.loader} server`, installedAt: new Date().toISOString() }
      if (vm.minecraft.status === 'running') {
        try {
          if (vm.route?.status !== 'active') {
            const record = await ensureNodeHostname(vm)
            vm.route = { type: 'minecraft', hostname: vm.domain, targetPort: 25565, gatewayHostname: publicGatewayHostname, gatewayIp: publicGatewayIp, status: 'active', cloudflareDnsId: record?.id || null, cloudflareSrvId: record?.srvId || null, browserRedirect: 'https://vyronhosting.com' }
          }
          if (vm.route) delete vm.route.error
        } catch (routeError) {
          vm.route = { ...(vm.route || {}), type: 'minecraft', hostname: vm.domain, targetPort: 25565, gatewayHostname: publicGatewayHostname, gatewayIp: publicGatewayIp, status: vm.route?.status || 'pending', error: routeError.message, browserRedirect: 'https://vyronhosting.com' }
        }
      }
    } catch (error) {
      vm.minecraft.status = 'failed'; vm.minecraft.stage = 'Installation failed'; vm.minecraft.error = error.message
    } finally { stageTimers.forEach(clearTimeout); activeMinecraftSetups.delete(vm.id); save() }
  })()
}
const syncMinecraft = async vm => {
  if (vm.template !== 'minecraft' || vm.status !== 'running' || !vm.minecraft?.rconPassword || ['queued', 'installing'].includes(vm.minecraft.status)) return
  try {
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/status?key=${encodeURIComponent(vm.minecraft.rconPassword)}`)
    vm.minecraft = { ...vm.minecraft, ...result, checkedAt: new Date().toISOString(), stage: result.status === 'running' ? 'Ready to play' : `Starting ${vm.minecraft.loader} server` }
    if (result.status === 'running') delete vm.minecraft.error
    if (result.status === 'running' && vm.route?.status !== 'active') {
      const record = await ensureNodeHostname(vm)
      vm.route = { type: 'minecraft', hostname: vm.domain, targetPort: 25565, gatewayHostname: publicGatewayHostname, gatewayIp: publicGatewayIp, status: 'active', cloudflareDnsId: record?.id || null, cloudflareSrvId: record?.srvId || null, browserRedirect: 'https://vyronhosting.com' }
    }
    vm.playerHistory ||= []
    const at = new Date().toISOString(), players = Number(result.playersOnline || 0), maxPlayers = Number(result.maxPlayers || vm.minecraft.maxPlayers || 20)
    const last = vm.playerHistory.at(-1)
    if (!last || Date.now() - new Date(last.at).getTime() >= 4500) vm.playerHistory.push({ at, players, maxPlayers })
    vm.playerHistory = vm.playerHistory.slice(-240)
  } catch {}
}

const cloudflareApiConfigured = () => Boolean(cloudflareToken && cloudflareAccountId)
const cloudflareConfigured = () => Boolean(cloudflareApiConfigured() && cloudflareTunnelId)
const cloudflareRequest = async (urlPath, options = {}) => {
  if (!cloudflareApiConfigured()) throw Object.assign(new Error('Cloudflare automation is not configured on the server platform.'), { status: 503 })
  const authorization = cloudflareEmail
    ? { 'X-Auth-Email': cloudflareEmail, 'X-Auth-Key': cloudflareToken }
    : { Authorization: `Bearer ${cloudflareToken}` }
  const response = await fetch(`https://api.cloudflare.com/client/v4${urlPath}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authorization, ...options.headers }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    const message = body.errors?.map(error => error.message).filter(Boolean).join('; ') || `Cloudflare API returned HTTP ${response.status}`
    throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : response.status })
  }
  return body.result
}
const customerDnsSecretKey = crypto.createHash('sha256').update(`${apiKey}:${agentToken}:vyron-customer-dns`).digest()
const sealCustomerToken = value => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', customerDnsSecretKey, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}
const openCustomerToken = sealed => {
  const decipher = crypto.createDecipheriv('aes-256-gcm', customerDnsSecretKey, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
}
const discordWebhookPattern = /^https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d{15,22}\/[A-Za-z0-9._-]{20,}$/
const eventPreference = event => event.type?.includes('usage') ? 'usage' : event.type?.includes('deploy') || event.type?.includes('github') ? 'deployment' : event.type?.includes('billing') || event.type?.includes('upgrade') ? 'billing' : event.type?.includes('security') ? 'security' : 'service'
const shouldEmailCustomerEvent = (user, event) => {
  const preference = eventPreference(event)
  if (user?.notifications?.[preference] === false) return false
  if (preference === 'billing' || preference === 'security') return true
  if (preference === 'usage') return user?.notifications?.usage === true
  // Routine starts, stops, restarts, successful deployments, GitHub pushes,
  // extension changes and recoveries remain in the activity feed and Discord.
  return event.severity === 'critical'
}
const sendDiscordWebhook = async (user, event) => {
  if (!user?.notifications?.discordWebhook || user.notifications.discordEnabled === false) return { sent: false, skipped: true }
  const preference = eventPreference(event)
  if (user.notifications[preference] === false) return { sent: false, skipped: true, preference }
  try {
    const url = openCustomerToken(user.notifications.discordWebhook)
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Vyron Hosting', allowed_mentions: { parse: [] }, embeds: [{ title: String(event.title || 'Vyron notification').slice(0, 256), description: String(event.detail || '').slice(0, 2000), color: event.severity === 'critical' ? 0xef4444 : event.severity === 'warning' ? 0xf59e0b : 0x7c5ce7, fields: [{ name: 'Event', value: String(event.type || 'platform').replaceAll('_', ' ').slice(0, 1024), inline: true }, ...(event.nodeName ? [{ name: 'Node', value: String(event.nodeName).slice(0, 1024), inline: true }] : [])], timestamp: event.createdAt || new Date().toISOString(), footer: { text: 'Vyron Technologies · EU Central' } }] }) })
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`)
    return { sent: true }
  } catch (error) { return { sent: false, error: error.message } }
}
const sendStripeDiscordWebhook = async (event, order, status = 'succeeded') => {
  if (!discordWebhookPattern.test(stripeDiscordWebhookUrl)) return { sent: false, skipped: true }
  const user = db.users.find(item => item.id === order?.userId)
  const successful = status === 'succeeded'
  try {
    const response = await fetch(stripeDiscordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Vyron Billing',
        allowed_mentions: { parse: [] },
        embeds: [{
          title: successful ? 'Stripe payment received' : 'Stripe payment failed',
          description: successful ? 'A Stripe Checkout payment was confirmed and the order is being processed.' : 'Stripe reported that a Checkout payment could not be completed.',
          color: successful ? 0x22c55e : 0xef4444,
          fields: [
            { name: 'Amount', value: `${Number(order?.total || 0).toFixed(2)} EUR`, inline: true },
            { name: 'Plan', value: String(plans[order?.plan]?.name || order?.plan || 'Upgrade').slice(0, 1024), inline: true },
            { name: 'Node', value: String(order?.nodeName || order?.pending?.name || 'Pending').slice(0, 1024), inline: true },
            { name: 'Customer', value: String(user?.email || 'Unknown').slice(0, 1024), inline: false },
            { name: 'Stripe event', value: String(event?.type || status).slice(0, 1024), inline: false }
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Vyron Technologies · Stripe test mode' }
        }]
      })
    })
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}`)
    return { sent: true }
  } catch (error) {
    createAdminNotification('payment_failure', 'Stripe Discord notification failed', error.message, { provider: 'discord', eventId: event?.id || null })
    return { sent: false, error: error.message }
  }
}
const createNodeEvent = (vm, type, title, detail, severity = 'info') => {
  db.nodeEvents ||= []
  const event = { id: crypto.randomUUID(), userId: vm.userId, workspaceId: vm.workspaceId, vmId: vm.id, nodeName: vm.name, type, title, detail, severity, createdAt: new Date().toISOString() }
  db.nodeEvents.push(event); db.nodeEvents = db.nodeEvents.slice(-5000); save()
  const user = db.users.find(item => item.id === vm.userId)
  void sendDiscordWebhook(user, event).then(result => { event.discord = { ...result, at: new Date().toISOString() }; save() })
  if (shouldEmailCustomerEvent(user, event)) void sendCustomerEmail(user, event).then(result => { event.email = { ...result, at: new Date().toISOString() }; save() })
  else event.email = { sent: false, skipped: true, at: new Date().toISOString() }
  return event
}
const evaluateUsageAlert = (vm, metrics, now = Date.now()) => {
  const owner = db.users.find(user => user.id === vm.userId), threshold = Number(owner?.notifications?.usageThreshold || 80)
  const usage = { CPU: Number(metrics.cpu || 0), memory: Number(metrics.usedRamMb || 0) / Math.max(1, Number(vm.ram || 1) * 1024) * 100, storage: Number(metrics.diskUsedGb || 0) / Math.max(1, Number(vm.disk || 1)) * 100 }
  const [resource, percent] = Object.entries(usage).sort((left, right) => right[1] - left[1])[0]
  const level = percent >= 100 ? 100 : percent >= 90 ? 90 : percent >= threshold ? threshold : 0
  const alertExpired = !vm.usageAlert?.at || now - new Date(vm.usageAlert.at).getTime() > 30 * 60_000
  if (owner?.notifications?.usage === true && level && (level > Number(vm.usageAlert?.level || 0) || alertExpired)) {
    vm.usageAlert = { resource, level, percent: +percent.toFixed(1), at: new Date().toISOString() }
    createNodeEvent(vm, 'usage_warning', `${resource} usage is ${percent.toFixed(1)}%`, `${vm.name} crossed the ${level}% warning level. Open the node to inspect live usage or upgrade its resources.`, percent >= 100 ? 'critical' : 'warning')
  } else if (percent < Math.max(0, threshold - 10) && vm.usageAlert) delete vm.usageAlert
}
const convertReferral = userId => {
  const referral = (db.referrals || []).find(item => item.referredUserId === userId && item.status === 'registered')
  if (!referral) return null
  const inviter = db.users.find(user => user.id === referral.inviterId)
  if (!inviter) return null
  referral.status = 'rewarded'; referral.rewardedAt = new Date().toISOString()
  inviter.referralCreditBalance = +(Number(inviter.referralCreditBalance || 0) + Number(referral.rewardAmount || 1)).toFixed(2)
  return referral
}
const customerCloudflareRequest = async (token, urlPath, options = {}) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${urlPath}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    const message = body.errors?.map(error => error.message).filter(Boolean).join('; ') || `Cloudflare API returned HTTP ${response.status}`
    throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : response.status })
  }
  return body.result
}
const findCustomerCloudflareZone = async (token, hostname) => {
  const labels = hostname.split('.')
  for (let index = Math.max(0, labels.length - 2); index >= 0; index--) {
    const name = labels.slice(index).join('.')
    const zones = await customerCloudflareRequest(token, `/zones?name=${encodeURIComponent(name)}&status=active&per_page=50`)
    if (zones?.[0]) return zones[0]
  }
  return null
}
const upsertCustomerDnsRecord = async (token, zoneId, record) => {
  const existing = await customerCloudflareRequest(token, `/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}&per_page=100`)
  // ACME/SSL validation may require multiple TXT values on the same hostname.
  // Updating the first match would overwrite an earlier validation token and
  // leave the custom hostname permanently stuck in pending_validation.
  if (record.type === 'TXT') {
    const exact = existing?.find(item => item.content === record.content)
    if (exact) return exact
    return customerCloudflareRequest(token, `/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: 'POST', body: JSON.stringify(record) })
  }
  if (existing?.[0]) return customerCloudflareRequest(token, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing[0].id)}`, { method: 'PUT', body: JSON.stringify(record) })
  return customerCloudflareRequest(token, `/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: 'POST', body: JSON.stringify(record) })
}
let cachedSaasZoneId = configuredCloudflareZoneId || null
const getSaasZoneId = async () => {
  if (cachedSaasZoneId) return cachedSaasZoneId
  const zones = await cloudflareRequest(`/zones?name=vyronhosting.com&account.id=${encodeURIComponent(cloudflareAccountId)}&status=active`)
  cachedSaasZoneId = zones?.[0]?.id || null
  if (!cachedSaasZoneId) throw Object.assign(new Error('The active vyronhosting.com zone was not found in this Cloudflare account.'), { status: 503 })
  return cachedSaasZoneId
}
const getCustomerZone = async hostname => {
  const labels = hostname.split('.')
  for (let index = Math.max(0, labels.length - 2); index >= 0; index--) {
    const name = labels.slice(index).join('.')
    const zones = await cloudflareRequest(`/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(cloudflareAccountId)}&status=active`)
    if (zones?.[0]) return zones[0]
  }
  return null
}
const upsertCloudflareDnsRecord = async (zoneId, record) => {
  const existing = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(record.name)}&per_page=100`)
  if (existing?.[0]) return cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing[0].id)}`, { method: 'PUT', body: JSON.stringify(record) })
  return cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: 'POST', body: JSON.stringify(record) })
}
const replaceCloudflareAddressRecord = async (zoneId, record) => {
  const existing = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(record.name)}&per_page=100`)
  const addressRecords = (existing || []).filter(item => ['A', 'AAAA', 'CNAME'].includes(item.type))
  const primary = addressRecords.find(item => item.type === record.type) || addressRecords[0]
  const result = primary
    ? await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(primary.id)}`, { method: 'PUT', body: JSON.stringify(record) })
    : await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records`, { method: 'POST', body: JSON.stringify(record) })
  for (const duplicate of addressRecords.filter(item => item.id !== primary?.id)) {
    await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(duplicate.id)}`, { method: 'DELETE' })
  }
  return result
}
let nodeTunnelIngressPromise = null
const ensureNodeTunnelIngress = () => {
  if (nodeTunnelIngressPromise) return nodeTunnelIngressPromise
  nodeTunnelIngressPromise = (async () => {
    const result = await cloudflareRequest(`/accounts/${encodeURIComponent(cloudflareAccountId)}/cfd_tunnel/${encodeURIComponent(cloudflareTunnelId)}/configurations`)
    const config = result?.config || {}
    const ingress = Array.isArray(config.ingress) ? [...config.ingress] : []
    const hostname = '*.vyronhosting.com'
    const existing = ingress.find(rule => rule.hostname === hostname)
    if (existing?.service === 'http://localhost:8800') return result
    const filtered = ingress.filter(rule => rule.hostname !== hostname)
    const catchAllIndex = filtered.findIndex(rule => !rule.hostname)
    const rule = { hostname, service: 'http://localhost:8800', originRequest: {} }
    filtered.splice(catchAllIndex < 0 ? filtered.length : catchAllIndex, 0, rule)
    return cloudflareRequest(`/accounts/${encodeURIComponent(cloudflareAccountId)}/cfd_tunnel/${encodeURIComponent(cloudflareTunnelId)}/configurations`, {
      method: 'PUT',
      body: JSON.stringify({ config: { ...config, ingress: filtered } })
    })
  })().catch(error => { nodeTunnelIngressPromise = null; throw error })
  return nodeTunnelIngressPromise
}
let customTunnelIngressQueue = Promise.resolve()
const ensureCustomTunnelIngress = hostname => {
  const normalized = clean(hostname).toLowerCase().replace(/\.$/, '')
  const operation = customTunnelIngressQueue.then(async () => {
    const result = await cloudflareRequest(`/accounts/${encodeURIComponent(cloudflareAccountId)}/cfd_tunnel/${encodeURIComponent(cloudflareTunnelId)}/configurations`)
    const config = result?.config || {}
    const ingress = Array.isArray(config.ingress) ? [...config.ingress] : []
    const existing = ingress.find(rule => rule.hostname === normalized)
    if (existing?.service === 'http://localhost:8800') return result
    const filtered = ingress.filter(rule => rule.hostname !== normalized)
    const catchAllIndex = filtered.findIndex(rule => !rule.hostname)
    filtered.splice(catchAllIndex < 0 ? filtered.length : catchAllIndex, 0, { hostname: normalized, service: 'http://localhost:8800', originRequest: {} })
    return cloudflareRequest(`/accounts/${encodeURIComponent(cloudflareAccountId)}/cfd_tunnel/${encodeURIComponent(cloudflareTunnelId)}/configurations`, {
      method: 'PUT',
      body: JSON.stringify({ config: { ...config, ingress: filtered } })
    })
  })
  customTunnelIngressQueue = operation.catch(() => {})
  return operation
}
const ensurePublicGatewayHostname = async () => {
  if (!cloudflareApiConfigured()) return null
  return upsertCloudflareDnsRecord(await getSaasZoneId(), {
    type: 'A', name: publicGatewayHostname, content: publicGatewayIp, ttl: 1, proxied: false, comment: 'Vyron public node gateway'
  })
}
const ensureNodeHostname = async vm => {
  if (vm.template === 'minecraft') {
    if (!cloudflareConfigured()) return null
    const zoneId = await getSaasZoneId()
    await ensureNodeTunnelIngress()
    await ensurePublicGatewayHostname()
    const webRecord = await replaceCloudflareAddressRecord(zoneId, {
      type: 'CNAME',
      name: vm.domain,
      content: `${cloudflareTunnelId}.cfargotunnel.com`,
      ttl: 1,
      proxied: true,
      comment: `Vyron Minecraft browser redirect: ${vm.name}`
    })
    const srvRecord = await upsertCloudflareDnsRecord(zoneId, {
      type: 'SRV',
      name: `_minecraft._tcp.${vm.domain}`,
      ttl: 1,
      data: { priority: 0, weight: 0, port: 25565, target: publicGatewayHostname },
      comment: `Vyron managed Minecraft service: ${vm.name}`
    })
    return { ...webRecord, srvId: srvRecord?.id || null }
  }
  if (!cloudflareConfigured() || !['node', 'nginx'].includes(vm.template)) return null
  await ensureNodeTunnelIngress()
  const zoneId = await getSaasZoneId()
  return upsertCloudflareDnsRecord(zoneId, {
    type: 'CNAME',
    name: vm.domain,
    content: `${cloudflareTunnelId}.cfargotunnel.com`,
    ttl: 1,
    proxied: true,
    comment: `Vyron managed web node: ${vm.name}`
  })
}
const ensureMinecraftCustomDomainSrv = async hostname => {
  const customerZone = await getCustomerZone(hostname)
  if (!customerZone) throw Object.assign(new Error('Automatic Minecraft routing requires this domain to be managed in the connected Cloudflare account.'), { status: 409 })
  await ensurePublicGatewayHostname()
  const result = await upsertCloudflareDnsRecord(customerZone.id, {
    type: 'SRV',
    name: `_minecraft._tcp.${hostname}`,
    ttl: 1,
    data: { priority: 0, weight: 0, port: 25565, target: publicGatewayHostname },
    comment: 'Vyron managed Minecraft service'
  })
  return { zoneId: customerZone.id, id: result.id }
}
const ensureAssignedWebDomainDns = async hostname => {
  if (!cloudflareConfigured()) return null
  const customerZone = await getCustomerZone(hostname)
  if (!customerZone) return null
  const result = await replaceCloudflareAddressRecord(customerZone.id, {
    type: 'CNAME',
    name: hostname,
    content: managedCnameTarget,
    ttl: 1,
    proxied: false,
    comment: 'Vyron managed custom web domain routing'
  })
  return { zoneId: customerZone.id, id: result.id }
}
const removeAssignedDomainDns = async record => {
  if (!record.assignedDnsRecord?.zoneId || !record.assignedDnsRecord?.id) return
  await cloudflareRequest(`/zones/${encodeURIComponent(record.assignedDnsRecord.zoneId)}/dns_records/${encodeURIComponent(record.assignedDnsRecord.id)}`, { method: 'DELETE' }).catch(() => {})
  delete record.assignedDnsRecord
}
const automateAssignedCustomDomainDns = async () => {
  let changed = false
  for (const record of db.domains.filter(item => item.vmId && item.status === 'active')) {
    if (record.dnsProvider !== 'cloudflare' || !record.dnsManaged) {
      if (record.assignedDnsRecord) { await removeAssignedDomainDns(record); changed = true }
      continue
    }
    const vm = db.vms.find(item => item.id === record.vmId && item.status !== 'deleted')
    if (!vm || !['node', 'nginx'].includes(vm.template)) continue
    try {
      const assignedDns = await ensureAssignedWebDomainDns(record.domain)
      if (assignedDns && (record.assignedDnsRecord?.id !== assignedDns.id || record.assignedDnsRecord?.zoneId !== assignedDns.zoneId)) { record.assignedDnsRecord = assignedDns; changed = true }
    } catch (error) { record.automationError = error.message; changed = true }
  }
  if (changed) save()
}
const automateNodeHostnames = async () => {
  const nodes = db.vms.filter(vm => {
    if (vm.status === 'deleted') return false
    if (vm.template === 'minecraft') return vm.minecraft?.status === 'running'
    if (!['node', 'nginx'].includes(vm.template)) return false
    // Website slots are independently managed services. A failed or stale
    // primary deployment must not prevent an otherwise healthy slot from
    // receiving its public Vyron hostname.
    return vm.deployment?.status === 'deployed' || vm.websites?.some(site => site.enabled !== false)
  })
  let changed = false
  for (const vm of nodes) {
    try {
      const record = await ensureNodeHostname(vm)
      if (vm.template === 'minecraft') {
        vm.route = { type: 'minecraft', hostname: vm.domain, targetPort: 25565, gatewayHostname: publicGatewayHostname, gatewayIp: publicGatewayIp, status: 'active', cloudflareDnsId: record?.id || null, cloudflareSrvId: record?.srvId || null, browserRedirect: 'https://vyronhosting.com' }
        changed = true
        continue
      }
      vm.route ||= { type: 'web', hostname: vm.domain, targetPort: vm.deployment?.appPort || 80, proxyPort: vm.deployment?.port || 80, status: 'active' }
      if (vm.route.status !== 'active') { vm.route.status = 'active'; changed = true }
      if (record?.id && vm.route.cloudflareDnsId !== record.id) { vm.route.cloudflareDnsId = record.id; changed = true }
      if (vm.route.dnsError) { delete vm.route.dnsError; changed = true }
    } catch (error) {
      vm.route ||= { type: 'web', hostname: vm.domain, status: 'pending' }
      vm.route.dnsError = error.message
      changed = true
    }
  }
  if (changed) save()
}
const createCloudflareCustomHostname = async (hostname, customerConnection = null) => {
  const zoneId = await getSaasZoneId()
  let customHostname
  try {
    customHostname = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/custom_hostnames`, { method: 'POST', body: JSON.stringify({ hostname, ssl: { method: 'txt', type: 'dv', min_tls_version: '1.2' } }) })
  } catch (error) {
    if (error.status !== 409) throw error
    const matches = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`)
    customHostname = matches?.[0]
    if (!customHostname) throw error
  }
  if (customHostname?.id) {
    try { customHostname = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(customHostname.id)}`) } catch {}
  }
  const dnsRecords = []
  if (customHostname.ownership_verification?.name && customHostname.ownership_verification?.value) dnsRecords.push({ purpose: 'ownership', type: 'TXT', name: customHostname.ownership_verification.name, value: customHostname.ownership_verification.value })
  for (const validation of customHostname.ssl?.validation_records || []) {
    const type = validation.txt_name ? 'TXT' : validation.cname ? 'CNAME' : null
    const name = validation.txt_name || validation.cname
    const value = validation.txt_value || validation.cname_target
    if (type && name && value) dnsRecords.push({ purpose: 'certificate', type, name, value })
  }
  dnsRecords.push({ purpose: 'routing', type: 'CNAME', name: hostname, value: managedCnameTarget })
  let dnsManaged = false
  const managedDnsRecords = []
  let customerToken = null
  try { customerToken = customerConnection?.token ? openCustomerToken(customerConnection.token) : null } catch {}
  // Never modify a customer's DNS zone with Vyron's platform token. Automatic
  // DNS is only allowed after the customer explicitly authorizes their own
  // Cloudflare token for this workspace.
  const customerZone = customerToken ? await findCustomerCloudflareZone(customerToken, hostname).catch(() => null) : null
  if (customerZone) {
    for (const record of dnsRecords) {
      const payload = { type: record.type, name: record.name, content: record.value, ttl: 1, proxied: false, comment: `Vyron automatic ${record.purpose} record` }
      const result = customerToken
        ? await upsertCustomerDnsRecord(customerToken, customerZone.id, payload)
        : await upsertCloudflareDnsRecord(customerZone.id, payload)
      managedDnsRecords.push({ zoneId: customerZone.id, id: result.id })
    }
    dnsManaged = true
    if (customHostname?.id && customHostname.ssl?.status !== 'active') {
      try {
        customHostname = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(customHostname.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ ssl: { method: 'txt', type: 'dv', min_tls_version: '1.2' } })
        })
      } catch {}
    }
  }
  return { customHostname, dnsRecords, dnsManaged, managedDnsRecords, zoneId, customerZone: customerZone ? { id: customerZone.id, name: customerZone.name } : null }
}
const applyManagedDomainProvisioning = (record, provisioned) => {
  record.cloudflareHostnameId = provisioned.customHostname.id
  record.cloudflareStatus = provisioned.customHostname.status
  record.sslStatus = provisioned.customHostname.ssl?.status || 'pending'
  record.dnsRecords = provisioned.dnsRecords
  record.dnsManaged = provisioned.dnsManaged
  record.managedDnsRecords = provisioned.managedDnsRecords
  record.cnameTarget = managedCnameTarget
  delete record.automationError
}
const automateStoredDomains = async () => {
  const pending = db.domains.filter(record => record.dnsProvider === 'cloudflare' && (!record.dnsManaged || record.sslStatus !== 'active'))
  for (const record of pending) {
    try {
      const workspace = db.workspaces.find(item => item.id === record.workspaceId)
      const connection = workspace?.dnsProviders?.cloudflare
      if (!connection) continue
      const provisioned = await createCloudflareCustomHostname(record.domain, connection)
      applyManagedDomainProvisioning(record, provisioned)
      const vm = db.vms.find(item => item.id === record.vmId && item.status !== 'deleted')
      if (vm && ['node', 'nginx'].includes(vm.template)) await ensureCustomTunnelIngress(record.domain)
    } catch (error) {
      record.automationError = error.message
    }
  }
  if (pending.length) save()
}
const normalizeDomainAutomation = () => {
  let changed = false
  for (const record of db.domains) {
    if (record.dnsManaged && record.dnsProvider !== 'cloudflare') {
      record.dnsManaged = false
      record.managedDnsRecords = []
      record.automationError = 'Manual DNS verification is required. No customer authorization was provided.'
      changed = true
    }
  }
  if (changed) save()
}
normalizeDomainAutomation()
setTimeout(() => { void automateStoredDomains() }, 1500)
setInterval(() => { void automateStoredDomains() }, 5 * 60_000).unref()
setTimeout(() => { void ensurePublicGatewayHostname().catch(error => console.error(`Public gateway DNS: ${error.message}`)) }, 1650)
setTimeout(() => { void automateAssignedCustomDomainDns() }, 1750)
setTimeout(() => { void automateNodeHostnames() }, 1800)
setInterval(() => { void automateNodeHostnames() }, 5 * 60_000).unref()
const listCloudflareRoutes = async () => {
  const result = await cloudflareRequest(`/accounts/${encodeURIComponent(cloudflareAccountId)}/teamnet/routes?per_page=1000`)
  return Array.isArray(result) ? result : []
}
const getCloudflarePrivateRoute = async () => {
  if (!cloudflareConfigured()) return null
  return (await listCloudflareRoutes()).find(route => route.network === privateNetwork && !route.deleted_at) || null
}
const ensureCloudflarePrivateRoute = async () => {
  const existing = await getCloudflarePrivateRoute()
  if (existing) {
    if (existing.tunnel_id !== cloudflareTunnelId) throw Object.assign(new Error(`${privateNetwork} is already attached to a different Cloudflare connector.`), { status: 409 })
    return { route: existing, created: false }
  }
  const route = await cloudflareRequest(`/accounts/${encodeURIComponent(cloudflareAccountId)}/teamnet/routes`, {
    method: 'POST',
    body: JSON.stringify({ network: privateNetwork, tunnel_id: cloudflareTunnelId, comment: 'Vyron managed node network' })
  })
  return { route, created: true }
}
const nodeConnections = vm => {
  const sshPort = Number(vm.access?.sshPort || 0)
  const accessHost = vm.access?.hostname || publicGatewayHostname
  const ports = sshPort ? [{ port: sshPort, protocol: 'TCP', service: 'SSH', visibility: 'public' }] : []
  if (vm.template === 'minecraft') ports.push({ port: 25565, protocol: 'TCP', service: 'Minecraft', visibility: 'public' })
  return {
    id: vm.id,
    name: vm.name,
    status: vm.status,
    publicHostname: vm.domain,
    username: vm.username || 'vyron',
    sshCommand: sshPort ? `ssh -p ${sshPort} ${vm.username || 'vyron'}@${accessHost}` : null,
    ports
  }
}

app.get('/health', (_, res) => res.json({ status: 'ok', region: 'eu-central', auth: true, billing: stripeTestConfigured(), paymentProvider: stripeTestConfigured() ? 'stripe-test' : null, infrastructure: 'managed' }))
app.get('/v1/status', async (_, res) => {
  let host = { status: 'offline', metrics: {}, system: { services: [] }, location: { id: 'de-muc-1', country: 'Germany', city: 'Munich', region: 'EU Central', latitude: 48.137, longitude: 11.575, status: 'degraded' } }
  try { host = await agentRequest('/health') } catch {}
  const serviceList = host.system?.services || []
  const service = (name, fallback = 'operational') => serviceList.find(item => item.name === name)?.status === 'online' ? 'operational' : fallback
  const locations = (db.statusConfig?.locations?.length ? db.statusConfig.locations : defaultStatusConfig().locations).map(location => ({ ...location, nodes: Number(host.metrics?.nodes || 0) }))
  const configuredState = locations.some(location => location.status === 'major') ? 'major' : locations.some(location => location.status === 'maintenance') ? 'degraded' : 'operational'
  const overall = configuredState !== 'operational' ? configuredState : host.status === 'ok' && service('vyron-agent', 'degraded') === 'operational' ? 'operational' : 'degraded'
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const incidents = (db.statusIncidents || []).slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
  const incidentFor = date => incidents.find(item => date >= new Date(item.startedAt).setUTCHours(0, 0, 0, 0) && date <= new Date(item.resolvedAt || Date.now()).setUTCHours(0, 0, 0, 0))
  const calendar = []
  for (let offset = 89; offset >= 0; offset -= 1) { const date = new Date(today); date.setUTCDate(today.getUTCDate() - offset); const incident = incidentFor(date.getTime()); const resolved = incident?.resolvedAt ? `Resolved at ${new Date(incident.resolvedAt).toLocaleString('en-GB', { timeZone: 'Europe/Berlin' })}` : null; calendar.push({ date: date.toISOString().slice(0, 10), state: incident?.state === 'major' ? 'major' : incident ? 'minor' : 'operational', label: incident ? `${incident.title}${resolved ? ' · resolved' : ''}` : 'No incidents reported', detail: resolved || incident?.detail || 'All services operational' }) }
  res.json({ status: overall, generatedAt: new Date().toISOString(), location: locations[0], locations, metrics: host.metrics || {}, services: [{ id: 'api', name: 'API', status: host.status === 'ok' ? 'operational' : 'major' }, { id: 'dashboard', name: 'Dashboard', status: service('vyron-panel', 'major') }, { id: 'agent', name: 'Agent', status: service('vyron-agent', 'major') }, { id: 'website', name: 'Website', status: service('vyron-app', 'major') }], history: (db.statusHistory || []).slice(-48), activeIncidents: incidents.filter(item => !item.resolvedAt), incidents, calendar })
})
app.get('/v1/plans', (_, res) => res.json({ plans: Object.values(plans), limits: { cpu: [0.5, 4], ram: [0.5, 12], disk: [20, 500] }, upgradeRates, gpuScheduling: false }))
app.get('/v1/capacity', requireAuth, async (_, res) => {
  const availability = creationAvailability()
  if (!availability.available) return res.status(503).json({ error: availability.reason, availability })
  try {
    const capacity = await agentRequest('/v1/capacity')
    res.json({ ...capacity, availability })
  } catch (error) {
    res.status(error.status || 503).json({ error: error.message || 'Capacity is currently unavailable.' })
  }
})
const normalizeReportDomain = input => {
  let value = clean(input).toLowerCase().replace(/\s/g, '')
  try { value = new URL(value.includes('://') ? value : `https://${value}`).hostname } catch { return '' }
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) ? value : ''
}
const domainClassification = domain => {
  const internal = domain.endsWith('.vyronhosting.com') ? domain.slice(0, -'.vyronhosting.com'.length) : ''
  const reserved = internal && !internal.includes('.') && RESERVED_HOSTNAMES.has(internal)
  const vm = db.vms.find(item => item.status !== 'deleted' && item.domain === domain)
  const custom = db.domains.find(item => item.domain === domain && item.vmId && item.verifiedAt)
  if (reserved || domain === 'vyronhosting.com') return { domain, status: 'official', hostedByVyron: true, operatedByVyron: true, reportable: true, label: 'Official Vyron Technologies service' }
  if (vm || custom) return { domain, status: 'hosted', hostedByVyron: true, operatedByVyron: false, reportable: true, label: 'Customer-operated service hosted on Vyron' }
  return { domain, status: 'unknown', hostedByVyron: false, operatedByVyron: false, reportable: true, label: 'Not identified as a Vyron-hosted service' }
}
const rateLimitHandler = (_, res) => res.status(429).json({ error: 'Rate limit reached. Please try again later.', code: 'RATE_LIMITED' })
const lookupLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitHandler })
const reportLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, handler: rateLimitHandler })
const verifyTurnstile = async (token, remoteip) => {
  if (!turnstileSecret || !turnstileSiteKey) throw Object.assign(new Error('Security verification is temporarily unavailable.'), { status: 503 })
  if (!token || token.length > 2048) return { success: false, errors: ['missing-input-response'] }
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: turnstileSecret, response: token, remoteip, idempotency_key: crypto.randomUUID() }) })
  if (!response.ok) throw Object.assign(new Error('Security verification could not be reached.'), { status: 502 })
  const result = await response.json()
  const trustedHost = ['vyronhosting.com', 'www.vyronhosting.com', 'app.vyronhosting.com'].includes(String(result.hostname || '').toLowerCase())
  return { success: result.success === true && result.action === 'domain_report' && trustedHost, errors: result['error-codes'] || [] }
}
app.get('/v1/report/config', (_, res) => res.json({ turnstile: { configured: Boolean(turnstileSiteKey && turnstileSecret), siteKey: turnstileSiteKey || null } }))
app.get('/v1/report/domain', lookupLimiter, (req, res) => {
  const domain = normalizeReportDomain(req.query.domain)
  if (!domain) return res.status(400).json({ error: 'Enter a valid domain name.' })
  res.json(domainClassification(domain))
})
app.post('/v1/report/domain', reportLimiter, async (req, res) => {
  const domain = normalizeReportDomain(req.body.domain), category = clean(req.body.category).toLowerCase(), details = clean(req.body.details).slice(0, 1600), reporterEmail = clean(req.body.reporterEmail).toLowerCase(), honeypot = clean(req.body.company), turnstileToken = clean(req.body.turnstileToken)
  if (honeypot) return res.status(202).json({ received: true })
  if (!domain) return res.status(400).json({ error: 'Enter a valid domain name.' })
  if (!['phishing', 'scam', 'malware', 'spam', 'other'].includes(category)) return res.status(400).json({ error: 'Choose a report category.' })
  if (details.length < 20) return res.status(400).json({ error: 'Please provide at least 20 characters of useful detail.' })
  if (reporterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) return res.status(400).json({ error: 'Enter a valid email address or leave it blank.' })
  try {
    const challenge = await verifyTurnstile(turnstileToken, req.ip)
    if (!challenge.success) return res.status(400).json({ error: 'Captcha verification failed or expired. Please complete it again.', code: 'CAPTCHA_FAILED' })
  } catch (error) { return res.status(error.status || 502).json({ error: error.message }) }
  const classification = domainClassification(domain)
  db.abuseReports ||= []
  const report = { id: crypto.randomUUID(), domain, category, details, reporterEmail: reporterEmail || null, domainStatus: classification.status, status: 'pending', createdAt: new Date().toISOString() }
  db.abuseReports.push(report)
  db.abuseReports = db.abuseReports.slice(-2000)
  createAdminNotification('domain_report', `New ${category} report for ${domain}`, `${classification.label}. Reporter details: ${details}`, { reportId: report.id, domain, category })
  res.status(201).json({ received: true, reportId: report.id, message: 'Thank you. Vyron Security will review this report.' })
})
app.post('/v1/auth/register', (req, res) => {
  const name = clean(req.body.name).slice(0, 60), email = clean(req.body.email).toLowerCase(), password = String(req.body.password || '')
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (req.body.acceptTerms !== true || req.body.acceptPrivacy !== true) return res.status(400).json({ error: 'You must accept the Terms and acknowledge the Privacy Policy.' })
  if (db.users.some(u => u.email === email)) return res.status(409).json({ error: 'This email is already registered.' })
  const referralCode = clean(req.body.referralCode).toUpperCase(), inviter = referralCode ? db.users.find(item => item.referralCode === referralCode) : null
  const user = { id: crypto.randomUUID(), name, email, passwordHash: hashPassword(password), referralCode: createReferralCode(name), referralCreditBalance: 0, createdAt: new Date().toISOString(), approvalRequestedAt: new Date().toISOString(), legalAcceptance: { termsVersion: '2026-09-08', privacyVersion: '2026-09-08', acceptedAt: new Date().toISOString() } }
  db.users.push(user)
  if (inviter) { db.referrals ||= []; db.referrals.push({ id: crypto.randomUUID(), inviterId: inviter.id, referredUserId: user.id, code: referralCode, status: 'registered', createdAt: new Date().toISOString(), rewardAmount: 1 }) }
  for (const workspace of db.workspaces) {
    const invitations = (workspace.invites || []).filter(invite => invite.email === email)
    for (const invite of invitations) {
      workspace.members ||= []; workspace.members.push({ userId: user.id, role: invite.role, invitedBy: invite.invitedBy, joinedAt: new Date().toISOString() })
      workspace.userIds = [...new Set([...(workspace.userIds || []), user.id])]
    }
    if (invitations.length) workspace.invites = workspace.invites.filter(invite => invite.email !== email)
  }
  save()
  createAdminNotification('account_approval', `New account awaiting approval`, `${name} (${email}) registered and cannot use Vyron until an administrator approves the account.`, { userId: user.id })
  res.status(202).json({ pendingApproval: true, code: 'ACCOUNT_PENDING', message: 'Your registration was received. An administrator must approve your account before you can sign in.' })
})
app.post('/v1/auth/login', (req, res) => {
  const user = db.users.find(u => u.email === clean(req.body.email).toLowerCase())
  if (!user || !verifyPassword(String(req.body.password || ''), user.passwordHash)) return res.status(401).json({ error: 'Email or password is incorrect.' })
  if (user.bannedAt) return res.status(403).json({ error: 'This account has been suspended. Contact Vyron support.' })
  if (approvalStatus(user) !== 'approved') return res.status(403).json({ error: approvalStatus(user) === 'rejected' ? 'This account request was not approved. Contact Vyron support if you think this is a mistake.' : 'Your account is waiting for administrator approval.', code: approvalStatus(user) === 'rejected' ? 'ACCOUNT_REJECTED' : 'ACCOUNT_PENDING' })
  if (user.twoFactor?.enabled) {
    const code = clean(req.body.twoFactorCode).toUpperCase().replace(/\s+/g, '')
    if (!code) return res.status(401).json({ error: 'Enter your authenticator or backup code.', code: 'TWO_FACTOR_REQUIRED' })
    const backupIndex = (user.twoFactor.backupCodeHashes || []).findIndex(hash => hash === backupCodeHash(code))
    if (!verifyTotp(user.twoFactor.secret, code) && backupIndex === -1) return res.status(401).json({ error: 'The two-factor code is invalid.', code: 'TWO_FACTOR_REQUIRED' })
    if (backupIndex >= 0) user.twoFactor.backupCodeHashes.splice(backupIndex, 1)
  }
  createSession(req, res, user.id); res.json({ user: publicUser(user) })
})
app.post('/v1/auth/passkeys/options', async (req, res) => {
  const user = db.users.find(item => item.email === clean(req.body.email).toLowerCase())
  if (!user || !(user.passkeys || []).length) return res.status(404).json({ error: 'No passkey is registered for this account.' })
  if (user.bannedAt) return res.status(403).json({ error: 'This account has been suspended. Contact Vyron support.' })
  if (approvalStatus(user) !== 'approved') return res.status(403).json({ error: 'This account is not approved for sign-in.' })
  try {
    const options = await generateAuthenticationOptions({
      rpID: webauthnRpId,
      allowCredentials: user.passkeys.map(passkey => ({ id: passkey.id, transports: passkey.transports || [] })),
      userVerification: 'required',
      timeout: 60_000
    })
    const challenge = createPasskeyChallenge(user.id, 'authentication', options.challenge)
    res.json({ options, challengeId: challenge.id })
  } catch (error) { res.status(500).json({ error: error.message || 'Passkey sign-in could not be started.' }) }
})
app.post('/v1/auth/passkeys/verify', async (req, res) => {
  const challengeId = clean(req.body.challengeId), response = req.body.response
  const challenge = (db.passkeyChallenges || []).find(item => item.id === challengeId && item.type === 'authentication' && item.expiresAt > Date.now())
  const user = challenge && db.users.find(item => item.id === challenge.userId)
  const passkey = user && (user.passkeys || []).find(item => item.id === response?.id)
  if (!challenge || !user || !passkey) return res.status(401).json({ error: 'Passkey sign-in expired or is invalid.' })
  consumePasskeyChallenge(challenge.id, user.id, 'authentication')
  if (user.bannedAt || approvalStatus(user) !== 'approved') return res.status(403).json({ error: 'This account is not allowed to sign in.' })
  try {
    const verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRpId, credential: storedWebAuthnCredential(passkey), requireUserVerification: true })
    if (!verification.verified) return res.status(401).json({ error: 'Passkey verification failed.' })
    passkey.counter = verification.authenticationInfo.newCounter
    passkey.lastUsedAt = new Date().toISOString()
    passkey.backedUp = verification.authenticationInfo.credentialBackedUp
    save(); createSession(req, res, user.id); recordAudit(req, 'security.passkey.login', user.id, { passkeyId: passkey.id })
    res.json({ verified: true, user: publicUser(user) })
  } catch (error) { res.status(401).json({ error: error.message || 'Passkey verification failed.' }) }
})
app.post('/v1/auth/logout', requireAuth, (req, res) => {
  db.sessions = db.sessions.filter(s => s !== req.session); save()
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  res.setHeader('Set-Cookie', `vyron_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`)
  res.json({ ok: true })
})
app.get('/v1/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }))

const workspaceRole = (user, workspace) => {
  if (!user || !workspace) return null
  if (workspace.ownerId === user.id) return 'owner'
  return workspace.members?.find(member => member.userId === user.id)?.role || (workspace.userIds?.includes(user.id) ? 'developer' : null)
}
const roleRank = role => ({ viewer: 1, developer: 2, admin: 3, owner: 4 }[role] || 0)
const userWorkspaces = user => db.workspaces.filter(w => Boolean(workspaceRole(user, w)))
const activeWorkspace = user => {
  const workspaces = userWorkspaces(user)
  return workspaces.find(w => w.id === user.activeWorkspaceId) || workspaces[0] || null
}
app.post('/v1/workspaces', requireAuth, (req, res) => {
  const name = clean(req.body.name).slice(0, 60)
  const slug = clean(req.body.slug).toLowerCase()
  if (name.length < 2) return res.status(400).json({ error: 'Workspace name must be at least 2 characters.' })
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(slug)) return res.status(400).json({ error: 'Workspace ID must be 3–32 characters.' })
  if (db.workspaces.some(w => w.slug === slug)) return res.status(409).json({ error: 'This workspace ID is already taken.' })
  const createdAt = new Date().toISOString()
  const workspace = { id: crypto.randomUUID(), name, slug, ownerId: req.user.id, userIds: [req.user.id], members: [{ userId: req.user.id, role: 'owner', joinedAt: createdAt }], region: 'eu-central', createdAt }
  db.workspaces.push(workspace)
  req.user.activeWorkspaceId = workspace.id
  // Preserve resources created before workspace support was introduced.
  for (const item of [...db.vms, ...db.orders]) if (item.userId === req.user.id && !item.workspaceId) item.workspaceId = workspace.id
  save()
  res.status(201).json({ workspace })
})
app.post('/v1/workspaces/:id/activate', requireAuth, (req, res) => {
  const workspace = userWorkspaces(req.user).find(w => w.id === req.params.id)
  if (!workspace) return res.status(404).json({ error: 'Workspace not found.' })
  req.user.activeWorkspaceId = workspace.id; save(); res.json({ workspace })
})
app.patch('/v1/workspaces/:id', requireAuth, (req, res) => {
  const workspace = db.workspaces.find(w => w.id === req.params.id && roleRank(workspaceRole(req.user, w)) >= 3)
  if (!workspace) return res.status(404).json({ error: 'Workspace not found.' })
  const name = clean(req.body.name).slice(0, 60), slug = clean(req.body.slug).toLowerCase()
  if (name.length < 2) return res.status(400).json({ error: 'Workspace name must be at least 2 characters.' })
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(slug)) return res.status(400).json({ error: 'Workspace ID must be 3–32 characters.' })
  if (db.workspaces.some(w => w.id !== workspace.id && w.slug === slug)) return res.status(409).json({ error: 'This workspace ID is already taken.' })
  workspace.name = name; workspace.slug = slug; save(); res.json({ workspace })
})
const publicWorkspaceMember = (workspace, member) => {
  const user = db.users.find(item => item.id === member.userId)
  return user ? { id: user.id, name: user.name, email: user.email, role: workspace.ownerId === user.id ? 'owner' : member.role, joinedAt: member.joinedAt, status: 'active' } : null
}
app.post('/v1/workspaces/:id/members', requireAuth, (req, res) => {
  const workspace = db.workspaces.find(item => item.id === req.params.id)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  const email = clean(req.body.email).toLowerCase(), role = clean(req.body.role).toLowerCase()
  if (!['admin', 'developer', 'viewer'].includes(role)) return res.status(400).json({ error: 'Choose Admin, Developer or Viewer.' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' })
  const user = db.users.find(item => item.email === email)
  if (user && workspaceRole(user, workspace)) return res.status(409).json({ error: 'This account is already a workspace member.' })
  if (!user) {
    if (workspace.invites?.some(invite => invite.email === email)) return res.status(409).json({ error: 'This email already has a pending invitation.' })
    const invite = { id: crypto.randomUUID(), email, role, invitedBy: req.user.id, createdAt: new Date().toISOString(), status: 'pending' }
    workspace.invites ||= []; workspace.invites.push(invite); save()
    return res.status(201).json({ member: { ...invite, name: 'Pending invitation' } })
  }
  const member = { userId: user.id, role, invitedBy: req.user.id, joinedAt: new Date().toISOString() }
  workspace.members ||= []; workspace.members.push(member)
  workspace.userIds = [...new Set([...(workspace.userIds || []), user.id])]
  save(); res.status(201).json({ member: publicWorkspaceMember(workspace, member) })
})
app.patch('/v1/workspaces/:id/members/:userId', requireAuth, (req, res) => {
  const workspace = db.workspaces.find(item => item.id === req.params.id)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  if (req.params.userId === workspace.ownerId) return res.status(400).json({ error: 'The workspace owner role cannot be changed.' })
  const role = clean(req.body.role).toLowerCase()
  if (!['admin', 'developer', 'viewer'].includes(role)) return res.status(400).json({ error: 'Choose Admin, Developer or Viewer.' })
  const member = workspace.members?.find(item => item.userId === req.params.userId)
  const invite = workspace.invites?.find(item => item.id === req.params.userId)
  if (!member && !invite) return res.status(404).json({ error: 'Workspace member not found.' })
  if (invite) { invite.role = role; save(); return res.json({ member: { ...invite, name: 'Pending invitation' } }) }
  member.role = role; save(); res.json({ member: publicWorkspaceMember(workspace, member) })
})
app.delete('/v1/workspaces/:id/members/:userId', requireAuth, (req, res) => {
  const workspace = db.workspaces.find(item => item.id === req.params.id)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  if (req.params.userId === workspace.ownerId) return res.status(400).json({ error: 'The workspace owner cannot be removed.' })
  const before = workspace.members?.length || 0
  const invitesBefore = workspace.invites?.length || 0
  workspace.members = (workspace.members || []).filter(item => item.userId !== req.params.userId)
  workspace.invites = (workspace.invites || []).filter(item => item.id !== req.params.userId)
  workspace.userIds = (workspace.userIds || []).filter(id => id !== req.params.userId)
  if (workspace.members.length === before && workspace.invites.length === invitesBefore) return res.status(404).json({ error: 'Workspace member not found.' })
  const removedUser = db.users.find(item => item.id === req.params.userId)
  if (removedUser?.activeWorkspaceId === workspace.id) removedUser.activeWorkspaceId = userWorkspaces(removedUser)[0]?.id || null
  save(); res.json({ ok: true })
})
app.patch('/v1/account/profile', requireAuth, (req, res) => {
  const name = clean(req.body.name).slice(0, 60), email = clean(req.body.email).toLowerCase()
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' })
  if (db.users.some(u => u.id !== req.user.id && u.email === email)) return res.status(409).json({ error: 'This email is already registered.' })
  req.user.name = name; req.user.email = email; save(); res.json({ user: publicUser(req.user) })
})
app.patch('/v1/account/password', requireAuth, (req, res) => {
  const current = String(req.body.currentPassword || ''), next = String(req.body.newPassword || '')
  if (!verifyPassword(current, req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' })
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' })
  req.user.passwordHash = hashPassword(next); save(); res.json({ ok: true })
})

app.post('/v1/account/passkeys/register/options', requireAuth, async (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Passkeys can only be managed from an interactive session.' })
  if (!verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' })
  if ((req.user.passkeys || []).length >= 10) return res.status(400).json({ error: 'Remove an existing passkey before adding another one.' })
  try {
    const options = await generateRegistrationOptions({
      rpName: 'Vyron Hosting',
      rpID: webauthnRpId,
      userName: req.user.email,
      userID: Buffer.from(req.user.id, 'utf8'),
      userDisplayName: req.user.name,
      attestationType: 'none',
      timeout: 60_000,
      excludeCredentials: (req.user.passkeys || []).map(passkey => ({ id: passkey.id, transports: passkey.transports || [] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257]
    })
    const challenge = createPasskeyChallenge(req.user.id, 'registration', options.challenge)
    res.json({ options, challengeId: challenge.id })
  } catch (error) { res.status(500).json({ error: error.message || 'Passkey registration could not be started.' }) }
})
app.post('/v1/account/passkeys/register/verify', requireAuth, async (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Passkeys can only be managed from an interactive session.' })
  const challenge = consumePasskeyChallenge(clean(req.body.challengeId), req.user.id, 'registration')
  if (!challenge) return res.status(400).json({ error: 'Passkey registration expired. Please try again.' })
  try {
    const verification = await verifyRegistrationResponse({
      response: req.body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: webauthnOrigin,
      expectedRPID: webauthnRpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257]
    })
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Passkey registration could not be verified.' })
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    if (db.users.some(user => (user.passkeys || []).some(passkey => passkey.id === credential.id))) return res.status(409).json({ error: 'This passkey is already registered.' })
    const passkey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: credential.transports || req.body.response?.response?.transports || [],
      name: clean(req.body.name).slice(0, 50) || 'My passkey',
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    }
    req.user.passkeys ||= []
    req.user.passkeys.push(passkey)
    save(); recordAudit(req, 'security.passkey.create', req.user.id, { passkeyId: passkey.id, name: passkey.name })
    res.status(201).json({ passkey: { id: passkey.id, name: passkey.name, deviceType: passkey.deviceType, backedUp: passkey.backedUp, createdAt: passkey.createdAt, lastUsedAt: null } })
  } catch (error) { res.status(400).json({ error: error.message || 'Passkey registration failed.' }) }
})
app.delete('/v1/account/passkeys/:id', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Passkeys can only be managed from an interactive session.' })
  if (!verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' })
  const passkey = (req.user.passkeys || []).find(item => item.id === req.params.id)
  if (!passkey) return res.status(404).json({ error: 'Passkey not found.' })
  req.user.passkeys = req.user.passkeys.filter(item => item.id !== req.params.id)
  save(); recordAudit(req, 'security.passkey.remove', req.user.id, { passkeyId: passkey.id, name: passkey.name })
  res.json({ ok: true })
})

app.patch('/v1/account/notifications', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Notification settings require an interactive session.' })
  req.user.notifications = {
    ...(req.user.notifications || {}),
    service: req.body.service !== false,
    billing: req.body.billing !== false,
    security: req.body.security !== false,
    deployment: req.body.deployment !== false,
    usage: req.body.usage !== false,
    usageThreshold: Math.min(95, Math.max(50, Number(req.body.usageThreshold) || 80))
  }
  save(); recordAudit(req, 'account.notifications.update', req.user.id, req.user.notifications)
  res.json({ notifications: req.user.notifications })
})

app.put('/v1/account/discord-webhook', requireAuth, async (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Discord settings require an interactive session.' })
  const webhookUrl = clean(req.body.webhookUrl)
  if (!discordWebhookPattern.test(webhookUrl)) return res.status(400).json({ error: 'Enter a valid Discord channel webhook URL.' })
  const testEvent = { type: 'connection_test', title: 'Vyron notifications connected', detail: 'Status changes, usage warnings, deployments and recovery events can now appear in this channel.', severity: 'info', createdAt: new Date().toISOString() }
  const response = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Vyron Hosting', allowed_mentions: { parse: [] }, embeds: [{ title: testEvent.title, description: testEvent.detail, color: 0x7c5ce7, timestamp: testEvent.createdAt, footer: { text: 'Vyron Technologies · Connection test' } }] }) })
  if (!response.ok) return res.status(400).json({ error: `Discord rejected the webhook (HTTP ${response.status}).` })
  req.user.notifications = { ...(req.user.notifications || {}), discordWebhook: sealCustomerToken(webhookUrl), discordEnabled: true, discordHint: `…/${webhookUrl.split('/').at(-2)}` }
  save(); recordAudit(req, 'notifications.discord.connect', req.user.id)
  res.json({ connected: true, hint: req.user.notifications.discordHint })
})
app.delete('/v1/account/discord-webhook', requireAuth, (req, res) => {
  if (req.user.notifications) { delete req.user.notifications.discordWebhook; delete req.user.notifications.discordHint; req.user.notifications.discordEnabled = false }
  save(); recordAudit(req, 'notifications.discord.disconnect', req.user.id); res.json({ connected: false })
})

app.post('/v1/account/2fa/setup', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Two-factor setup requires an interactive session.' })
  if (!verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' })
  const secret = base32Encode(crypto.randomBytes(20))
  req.user.pendingTwoFactorSecret = secret; save()
  const issuer = 'Vyron Hosting', label = encodeURIComponent(`${issuer}:${req.user.email}`)
  res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` })
})
app.post('/v1/account/2fa/enable', requireAuth, (req, res) => {
  const secret = req.user.pendingTwoFactorSecret, code = clean(req.body.code)
  if (!secret) return res.status(409).json({ error: 'Start two-factor setup again.' })
  if (!verifyTotp(secret, code)) return res.status(400).json({ error: 'The authenticator code is invalid.' })
  const backupCodes = Array.from({ length: 8 }, () => `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`)
  req.user.twoFactor = { enabled: true, secret, backupCodeHashes: backupCodes.map(backupCodeHash), enabledAt: new Date().toISOString() }
  delete req.user.pendingTwoFactorSecret; save(); recordAudit(req, 'security.2fa.enable', req.user.id)
  res.json({ enabled: true, backupCodes })
})
app.post('/v1/account/2fa/disable', requireAuth, (req, res) => {
  if (!verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Current password is incorrect.' })
  const code = clean(req.body.code)
  if (req.user.twoFactor?.enabled && !verifyTotp(req.user.twoFactor.secret, code) && !(req.user.twoFactor.backupCodeHashes || []).includes(backupCodeHash(code))) return res.status(400).json({ error: 'The two-factor code is invalid.' })
  delete req.user.twoFactor; delete req.user.pendingTwoFactorSecret; save(); recordAudit(req, 'security.2fa.disable', req.user.id)
  res.json({ enabled: false })
})

app.get('/v1/support/tickets', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user)
  res.json({ tickets: (db.supportTickets || []).filter(ticket => ticket.workspaceId === workspace?.id).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) })
})
app.post('/v1/support/tickets', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user), subject = clean(req.body.subject).slice(0, 120), message = clean(req.body.message).slice(0, 4000), vmId = clean(req.body.vmId)
  if (!workspace) return res.status(409).json({ error: 'Select a workspace first.' })
  if (subject.length < 4 || message.length < 10) return res.status(400).json({ error: 'Add a subject and at least 10 characters of detail.' })
  const vm = vmId ? db.vms.find(item => item.id === vmId && item.workspaceId === workspace.id && item.status !== 'deleted') : null
  const ticket = { id: crypto.randomUUID(), number: `VYR-${String((db.supportTickets || []).length + 1).padStart(5, '0')}`, userId: req.user.id, workspaceId: workspace.id, vmId: vm?.id || null, nodeName: vm?.name || null, subject, status: 'open', priority: ['low', 'normal', 'high', 'urgent'].includes(clean(req.body.priority)) ? clean(req.body.priority) : 'normal', messages: [{ id: crypto.randomUUID(), authorId: req.user.id, author: req.user.email, message, createdAt: new Date().toISOString() }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  db.supportTickets ||= []; db.supportTickets.push(ticket); save(); createAdminNotification('support_ticket', `New support ticket ${ticket.number}`, `${subject}${vm ? ` · ${vm.name}` : ''}`, { ticketId: ticket.id, workspaceId: workspace.id })
  res.status(201).json({ ticket })
})
app.post('/v1/support/tickets/:id/reply', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user), ticket = (db.supportTickets || []).find(item => item.id === req.params.id && item.workspaceId === workspace?.id), message = clean(req.body.message).slice(0, 4000)
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' })
  if (message.length < 2) return res.status(400).json({ error: 'Enter a reply.' })
  ticket.messages.push({ id: crypto.randomUUID(), authorId: req.user.id, author: req.user.email, message, createdAt: new Date().toISOString() }); ticket.updatedAt = new Date().toISOString(); save(); res.json({ ticket })
})

app.get('/v1/account/referrals', requireAuth, (req, res) => {
  req.user.referralCode ||= createReferralCode(req.user.name)
  const referrals = (db.referrals || []).filter(item => item.inviterId === req.user.id).map(item => ({ ...item, referredEmail: db.users.find(user => user.id === item.referredUserId)?.email?.replace(/^(.{2}).*(@.*)$/, '$1•••$2') || 'Registered user' }))
  save(); res.json({ code: req.user.referralCode, link: `https://app.vyronhosting.com/register?ref=${encodeURIComponent(req.user.referralCode)}`, creditBalance: Number(req.user.referralCreditBalance || 0), referrals })
})

app.get('/v1/account/api-tokens', requireAuth, (req, res) => {
  res.json({ tokens: (db.apiTokens || []).filter(item => item.userId === req.user.id && !item.revokedAt).map(({ tokenHash, ...item }) => item) })
})
app.post('/v1/account/api-tokens', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'API tokens can only be created from an interactive session.' })
  if (!verifyPassword(String(req.body.password || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Enter your current password to create a token.' })
  const name = clean(req.body.name).slice(0, 50)
  if (name.length < 2) return res.status(400).json({ error: 'Token name must be at least 2 characters.' })
  const scopes = [...new Set((Array.isArray(req.body.scopes) ? req.body.scopes : ['read']).filter(scope => ['read', 'operate'].includes(scope)))]
  if (!scopes.includes('read')) scopes.unshift('read')
  const active = (db.apiTokens || []).filter(item => item.userId === req.user.id && !item.revokedAt)
  if (active.length >= 10) return res.status(409).json({ error: 'Revoke an existing token before creating another one.' })
  const value = `vyr_${crypto.randomBytes(30).toString('base64url')}`
  const item = { id: crypto.randomUUID(), userId: req.user.id, name, scopes, tokenHash: crypto.createHash('sha256').update(value).digest('hex'), hint: `${value.slice(0, 9)}…${value.slice(-4)}`, createdAt: new Date().toISOString(), lastUsedAt: null }
  db.apiTokens ||= []; db.apiTokens.push(item); save(); recordAudit(req, 'api_token.create', item.id, { name, scopes })
  const { tokenHash, ...publicToken } = item
  res.status(201).json({ token: value, item: publicToken })
})
app.delete('/v1/account/api-tokens/:id', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'API tokens can only be revoked from an interactive session.' })
  const item = (db.apiTokens || []).find(token => token.id === req.params.id && token.userId === req.user.id && !token.revokedAt)
  if (!item) return res.status(404).json({ error: 'API token not found.' })
  item.revokedAt = new Date().toISOString(); save(); recordAudit(req, 'api_token.revoke', item.id, { name: item.name })
  res.json({ ok: true })
})

app.get('/v1/account/sessions', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Sessions require an interactive login.' })
  res.json({ sessions: db.sessions.filter(item => item.userId === req.user.id && item.expiresAt > Date.now()).map(item => ({ id: item.id, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt, ip: item.ip, userAgent: item.userAgent, current: item === req.session })) })
})
app.delete('/v1/account/sessions/:id', requireAuth, (req, res) => {
  if (req.apiToken) return res.status(403).json({ error: 'Sessions require an interactive login.' })
  const before = db.sessions.length
  db.sessions = db.sessions.filter(item => !(item.userId === req.user.id && item.id === req.params.id))
  if (db.sessions.length === before) return res.status(404).json({ error: 'Session not found.' })
  save(); recordAudit(req, 'session.revoke', req.params.id)
  res.json({ ok: true, current: req.session?.id === req.params.id })
})

app.get('/v1/invoices/:id', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).send('Billing access required.')
  const order = db.orders.find(item => item.id === req.params.id && item.workspaceId === workspace.id && item.status === 'paid')
  if (!order) return res.status(404).send('Invoice not found.')
  const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
  const date = new Date(order.paidAt || order.createdAt)
  const number = `VY-${date.getUTCFullYear()}-${order.id.slice(0, 8).toUpperCase()}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${number}</title><style>body{font:14px Inter,Arial,sans-serif;color:#18181b;margin:0;padding:48px}main{max-width:760px;margin:auto}.top{display:flex;justify-content:space-between;border-bottom:2px solid #18181b;padding-bottom:24px}.brand{font-size:24px;font-weight:800}.brand i{color:#7c5ce7;font-style:normal}.meta{text-align:right;color:#62626b}h1{font-size:32px;margin:48px 0 8px}table{width:100%;border-collapse:collapse;margin-top:32px}th,td{text-align:left;padding:14px;border-bottom:1px solid #ddd}th:last-child,td:last-child{text-align:right}.total{font-size:20px;font-weight:800}.paid{display:inline-block;background:#dcfce7;color:#166534;padding:6px 10px;border-radius:999px;font-weight:700}footer{margin-top:60px;color:#71717a;font-size:12px}@media print{body{padding:0}.print{display:none}}</style></head><body><main><div class="top"><div class="brand"><i>vyron</i> technologies</div><div class="meta"><b>${number}</b><br>${date.toLocaleDateString('en-GB')}<br><span class="paid">PAID</span></div></div><h1>Invoice receipt</h1><p>Billed to ${safe(req.user.name)} &lt;${safe(req.user.email)}&gt;<br>Workspace: ${safe(workspace.name)}</p><table><thead><tr><th>Description</th><th>Amount</th></tr></thead><tbody><tr><td>${safe(order.plan || 'Vyron Hosting')} monthly service</td><td>€${Number(order.subtotal ?? order.total ?? 0).toFixed(2)}</td></tr>${Number(order.discount || 0) ? `<tr><td>Discount ${safe(order.coupon || '')}</td><td>−€${Number(order.discount).toFixed(2)}</td></tr>` : ''}<tr class="total"><td>Total</td><td>€${Number(order.total || 0).toFixed(2)}</td></tr></tbody></table><footer>Vyron Technologies · Electronic payment receipt · Transaction ${safe(order.stripePaymentIntentId || order.stripeSessionId || order.paypalOrderId || order.id)}</footer><p class="print"><button onclick="window.print()">Print or save as PDF</button></p></main></body></html>`
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
  res.send(html)
})

const syncWorkspaceJobs = async workspaceId => {
  let changed = false
  for (const vm of db.vms.filter(v => v.workspaceId === workspaceId && v.jobId && ['queued', 'provisioning'].includes(v.status))) {
    try {
      const job = await agentRequest(`/v1/jobs/${encodeURIComponent(vm.jobId)}`)
      if (job.state !== vm.status) { vm.status = job.state; changed = true }
      if (job.result) { vm.username = job.result.username; vm.initialPassword = job.result.initialPassword || vm.initialPassword; vm.access = job.result.access || vm.access; vm.status = job.result.status; delete vm.error; changed = true }
      if (job.error) { vm.error = job.error; changed = true }
    } catch {}
  }
  for (const vm of db.vms.filter(v => v.workspaceId === workspaceId && v.status === 'running' && !v.access?.sshPort)) {
    try { vm.access = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/access`); changed = true } catch {}
  }
  for (const vm of db.vms.filter(v => v.workspaceId === workspaceId && v.status === 'running' && !v.initialPassword && !activeSshCredentialRepairs.has(v.id))) {
    activeSshCredentialRepairs.add(vm.id)
    try {
      const credentials = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/ssh-password`, { method: 'POST' })
      vm.username = credentials.username || 'vyron'
      vm.initialPassword = credentials.initialPassword
      changed = true
    } catch {} finally { activeSshCredentialRepairs.delete(vm.id) }
  }
  for (const vm of db.vms.filter(v => v.workspaceId === workspaceId && v.template === 'minecraft' && v.status === 'running')) {
    if (vm.minecraft?.status === 'queued') startMinecraftSetup(vm)
    else await syncMinecraft(vm)
  }
  for (const vm of db.vms.filter(v => v.workspaceId === workspaceId && v.status === 'running' && v.deployment?.status === 'queued' && (v.uploadPath || v.github?.repository))) startNodeDeployment(vm)
  if (changed) save()
}
const syncVmStates = async vms => {
  let changed = false
  await Promise.all(vms.filter(vm => !['deleted', 'queued', 'provisioning'].includes(vm.status)).map(async vm => {
    try {
      const actual = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/status`)
      const unexpectedStop = ['stopped', 'shut off', 'crashed'].includes(String(actual.status).toLowerCase()) && vm.desiredState !== 'stopped' && vm.runtime?.autoRestart !== false
      const recoveryDue = !vm.lastRecoveryAttemptAt || Date.now() - new Date(vm.lastRecoveryAttemptAt).getTime() > 60_000
      if (unexpectedStop && recoveryDue && creationAvailability().available) {
        vm.lastRecoveryAttemptAt = new Date().toISOString()
        vm.incidents ||= []
        vm.incidents.push({ id: crypto.randomUUID(), type: 'unexpected_stop', at: vm.lastRecoveryAttemptAt, state: actual.status })
        vm.incidents = vm.incidents.slice(-50)
        try {
          const recovered = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/start`, { method: 'POST' })
          vm.status = recovered.status || 'running'; vm.lastRecoveredAt = new Date().toISOString(); changed = true
          createAdminNotification('node_recovered', `Node ${vm.name} recovered automatically`, 'The node stopped unexpectedly and was started again by Vyron crash recovery.', { nodeId: vm.id, workspaceId: vm.workspaceId })
          createNodeEvent(vm, 'node_recovered', 'Node recovered automatically', 'Vyron detected an unexpected stop and started the node again.', 'warning')
          return
        } catch (recoveryError) {
          vm.lastRecoveryError = recoveryError.message; changed = true
        }
      }
      if (actual.status !== vm.status) {
        const previousStatus = vm.status
        vm.status = actual.status
        vm.stateChangedAt = new Date().toISOString()
        createNodeEvent(vm, 'node_state_changed', `Node is now ${actual.status}`, `State changed from ${previousStatus} to ${actual.status}.`, ['failed', 'missing', 'crashed'].includes(String(actual.status).toLowerCase()) ? 'critical' : 'info')
        changed = true
      }
      if (String(actual.status).toLowerCase() === 'running' && vm.error) { delete vm.error; changed = true }
    } catch (error) {
      if (error.status === 404 && vm.status !== 'missing') {
        vm.status = 'missing'
        vm.stateChangedAt = new Date().toISOString()
        changed = true
      }
    }
  }))
  if (changed) save()
}
const requireMcpToken = (req, res, next) => {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const tokenHash = bearer.startsWith('vyr_') ? crypto.createHash('sha256').update(bearer).digest('hex') : ''
  const apiToken = tokenHash && (db.apiTokens || []).find(item => item.tokenHash === tokenHash && !item.revokedAt)
  const user = apiToken && db.users.find(item => item.id === apiToken.userId)
  if (!user || user.bannedAt || approvalStatus(user) !== 'approved') {
    res.setHeader('WWW-Authenticate', 'Bearer realm="Vyron MCP"')
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'A valid Vyron API token is required.' }, id: null })
  }
  const workspace = activeWorkspace(user)
  if (!workspace) return res.status(409).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Select a Vyron workspace first.' }, id: null })
  apiToken.lastUsedAt = new Date().toISOString()
  req.user = user; req.apiToken = apiToken; req.mcpWorkspace = workspace
  next()
}
app.post('/mcp', requireMcpToken, async (req, res) => {
  const workspace = req.mcpWorkspace, role = workspaceRole(req.user, workspace)
  const record = (action, target, detail = {}) => {
    db.auditLogs ||= []
    db.auditLogs.push({ id: crypto.randomUUID(), userId: req.user.id, email: req.user.email, action, target, detail: { ...detail, workspaceId: workspace.id, apiTokenId: req.apiToken.id }, ip: req.ip, at: new Date().toISOString() })
    db.auditLogs = db.auditLogs.slice(-5000); save()
  }
  const server = createVyronMcpServer({ db, user: req.user, workspace, apiToken: req.apiToken, roleRank: roleRank(role), agentRequest, save, record, creationAvailability, syncVmStates })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { void transport.close(); void server.close() })
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body) }
  catch (error) {
    console.error('MCP request failed:', error.message)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Vyron MCP request failed.' }, id: req.body?.id ?? null })
  }
})
app.get('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use Streamable HTTP POST for this MCP server.' }, id: null }))
app.delete('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'This MCP server is stateless.' }, id: null }))
const stateSyncTimer = setInterval(() => {
  void syncVmStates(db.vms.filter(vm => vm.status !== 'deleted'))
}, 5000)
stateSyncTimer.unref()
const usageMonitorTimer = setInterval(() => {
  void Promise.all(db.vms.filter(vm => vm.status === 'running').map(async vm => {
    try { const metrics = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/metrics`); vm.metrics = metrics; evaluateUsageAlert(vm, metrics) } catch {}
  })).then(() => save())
}, 30_000)
usageMonitorTimer.unref()
app.get('/v1/account', requireAuth, async (req, res) => {
  const workspaces = userWorkspaces(req.user)
  const workspace = activeWorkspace(req.user)
  if (workspace) await syncWorkspaceJobs(workspace.id)
  if (workspace && req.user.activeWorkspaceId !== workspace.id) { req.user.activeWorkspaceId = workspace.id; save() }
  let host = { status: 'offline', host: 'vyron-servers', metrics: {} }
  try { host = await agentRequest('/health') } catch {}
  const now = Date.now(), lastHost = db.hostHistory.at(-1)
  if (host.status === 'ok' && (!lastHost || now - new Date(lastHost.at).getTime() >= 4500)) {
    db.hostHistory.push({ at: new Date(now).toISOString(), cpu: host.metrics.cpu || 0, ram: host.metrics.usedRam || 0 })
    db.hostHistory = db.hostHistory.slice(-240)
  }
  const userVms = workspace ? db.vms.filter(v => v.workspaceId === workspace.id) : []
  await syncVmStates(userVms)
  for (const vm of userVms.filter(v => v.status === 'running')) {
    try {
      const metrics = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/metrics`)
      vm.metrics = metrics
      vm.metricsHistory ||= []
      const last = vm.metricsHistory.at(-1)
      if (!last || now - new Date(last.at).getTime() >= 4500) vm.metricsHistory.push({ at: metrics.at, cpu: metrics.cpu, ram: metrics.usedRamMb, disk: metrics.diskUsedGb, network: metrics.networkMbps })
      vm.metricsHistory = vm.metricsHistory.slice(-240)
      evaluateUsageAlert(vm, metrics, now)
    } catch {}
  }
  save()
  const workspaceDomains = workspace ? db.domains.filter(domain => domain.workspaceId === workspace.id) : []
  const members = workspace ? [...(workspace.members || []).map(member => publicWorkspaceMember(workspace, member)).filter(Boolean), ...(workspace.invites || []).map(invite => ({ ...invite, name: 'Pending invitation' }))] : []
  const role = workspaceRole(req.user, workspace)
  const canOperate = roleRank(role) >= 2
  const notificationSettings = { service: true, billing: true, security: true, deployment: true, usage: false, usageThreshold: 80, ...(req.user.notifications || {}) }
  delete notificationSettings.discordWebhook
  const security = {
    notifications: notificationSettings,
    discord: { connected: Boolean(req.user.notifications?.discordWebhook), enabled: req.user.notifications?.discordEnabled !== false, hint: req.user.notifications?.discordHint || '' },
    twoFactor: { enabled: Boolean(req.user.twoFactor?.enabled), backupCodesRemaining: req.user.twoFactor?.backupCodeHashes?.length || 0 },
    passkeys: (req.user.passkeys || []).map(({ publicKey, counter, transports, ...passkey }) => passkey),
    apiTokens: (db.apiTokens || []).filter(item => item.userId === req.user.id && !item.revokedAt).map(({ tokenHash, userId, ...item }) => item),
    sessions: db.sessions.filter(item => item.userId === req.user.id && item.expiresAt > Date.now()).map(item => ({ id: item.id, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt, ip: item.ip, userAgent: item.userAgent, current: item === req.session }))
  }
  const orders = workspace && roleRank(role) >= 3 ? db.orders.filter(o => o.workspaceId === workspace.id).map(({ userId, pending, ...o }) => ({ ...o, invoiceNumber: o.status === 'paid' ? `VY-${new Date(o.paidAt || o.createdAt).getUTCFullYear()}-${o.id.slice(0, 8).toUpperCase()}` : null })) : []
  const events = workspace ? (db.nodeEvents || []).filter(event => event.workspaceId === workspace.id).slice(-100).reverse() : []
  const auditLogs = workspace && roleRank(role) >= 3 ? (db.auditLogs || []).filter(log => log.userId === req.user.id || log.detail?.workspaceId === workspace.id).slice(-100).reverse() : []
  res.json({ user: publicUser(req.user), security, events, auditLogs, workspace: workspace ? { id: workspace.id, name: workspace.name, slug: workspace.slug, region: workspace.region, createdAt: workspace.createdAt, role, permissions: { view: true, operate: canOperate, manage: roleRank(role) >= 3, owner: role === 'owner' }, members } : null, workspaces: workspaces.map(item => ({ id: item.id, name: item.name, slug: item.slug, region: item.region, role: workspaceRole(req.user, item) })), host: { ...host, host: 'vyron-servers', history: db.hostHistory }, vms: userVms.map(({ userId, uploadPath, initialPassword, runtime, github, ...v }) => ({ ...v, runtime: runtime ? { autoRestart: runtime.autoRestart !== false, environmentKeys: Object.keys(runtime.environment || {}), schedule: runtime.schedule || null } : { autoRestart: true, environmentKeys: [], schedule: null }, github: github ? { repository: github.repository, branch: github.branch || null, webhookUrl: `${publicGatewayHostname}/api/v1/webhooks/github`, webhookSecret: canOperate ? github.webhookSecret : undefined, autoDeploy: github.autoDeploy !== false } : null, initialPassword: canOperate ? initialPassword : undefined, minecraft: v.minecraft ? (({ rconPassword, ...minecraft }) => minecraft)(v.minecraft) : undefined, playerHistory: v.playerHistory || [], events: events.filter(event => event.vmId === v.id).slice(0, 30), customDomains: workspaceDomains.filter(domain => domain.vmId === v.id), remoteAccess: canOperate && v.access?.sshPort ? { address: v.access.hostname || publicGatewayHostname, username: v.username || 'vyron', sshPort: v.access.sshPort, tcpPorts: [v.access.sshPort, ...(v.template === 'minecraft' ? [25565] : [])] } : null, metrics: v.metrics ? (({ ip, ...metrics }) => metrics)(v.metrics) : v.metrics })), domains: workspaceDomains, orders })
})

const aiGreeting = 'Hi — I’m Vyron Copilot. Ask me any general or hosting question. I can also inspect node health and propose safe actions for your approval.'
const ownedAiChat = (req, workspace, id) => (db.aiChats || []).find(item => item.id === id && item.userId === req.user.id && item.workspaceId === workspace?.id)
const publicAiChat = (chat, includeMessages = false) => ({ id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, ...(includeMessages ? { messages: chat.messages || [] } : {}) })

app.get('/v1/ai/chats', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (!workspace) return res.status(409).json({ error: 'Select a workspace first.' })
  const chats = (db.aiChats || []).filter(item => item.userId === req.user.id && item.workspaceId === workspace.id).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 50).map(item => publicAiChat(item))
  const memories = (db.aiMemories || []).filter(item => item.userId === req.user.id && item.workspaceId === workspace.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 30).map(({ userId, workspaceId, ...item }) => item)
  res.json({ chats, memories })
})
app.post('/v1/ai/chats', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (!workspace) return res.status(409).json({ error: 'Select a workspace first.' })
  const now = new Date().toISOString(), chat = { id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, title: clean(req.body?.title).slice(0, 60) || 'New chat', messages: [{ role: 'assistant', content: aiGreeting }], createdAt: now, updatedAt: now }
  db.aiChats ||= []; db.aiChats.push(chat); save(); res.status(201).json(publicAiChat(chat, true))
})
app.get('/v1/ai/chats/:id', requireAuth, (req, res) => {
  const chat = ownedAiChat(req, activeWorkspace(req.user), req.params.id)
  if (!chat) return res.status(404).json({ error: 'Chat not found.' })
  res.json(publicAiChat(chat, true))
})
app.patch('/v1/ai/chats/:id', requireAuth, (req, res) => {
  const chat = ownedAiChat(req, activeWorkspace(req.user), req.params.id), title = clean(req.body?.title).slice(0, 60)
  if (!chat) return res.status(404).json({ error: 'Chat not found.' })
  if (!title) return res.status(400).json({ error: 'Enter a chat name.' })
  chat.title = title; chat.updatedAt = new Date().toISOString(); save(); res.json(publicAiChat(chat))
})
app.delete('/v1/ai/chats/:id', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user), chat = ownedAiChat(req, workspace, req.params.id)
  if (!chat) return res.status(404).json({ error: 'Chat not found.' })
  db.aiChats = db.aiChats.filter(item => item.id !== chat.id); save(); res.json({ removed: chat.id })
})
app.post('/v1/ai/memories', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user), content = clean(req.body?.content).replace(/\s+/g, ' ').slice(0, 300)
  if (!workspace) return res.status(409).json({ error: 'Select a workspace first.' })
  if (!content) return res.status(400).json({ error: 'Enter something to remember.' })
  db.aiMemories ||= []
  const duplicate = db.aiMemories.find(item => item.userId === req.user.id && item.workspaceId === workspace.id && item.content.toLowerCase() === content.toLowerCase())
  const memory = duplicate || { id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, content, createdAt: new Date().toISOString() }
  if (!duplicate) { db.aiMemories.push(memory); db.aiMemories = db.aiMemories.slice(-1000); save() }
  const { userId, workspaceId, ...result } = memory; res.status(duplicate ? 200 : 201).json(result)
})
app.delete('/v1/ai/memories/:id', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user), memory = (db.aiMemories || []).find(item => item.id === req.params.id && item.userId === req.user.id && item.workspaceId === workspace?.id)
  if (!memory) return res.status(404).json({ error: 'Memory not found.' })
  db.aiMemories = db.aiMemories.filter(item => item.id !== memory.id); save(); res.json({ removed: memory.id })
})

app.post('/v1/ai/chat', requireAuth, async (req, res) => {
  const payload = req.body || {}, workspace = activeWorkspace(req.user), question = clean(payload.message).slice(0, 1200)
  if (!workspace) return res.status(409).json({ error: 'Select a workspace first.' })
  if (!question) return res.status(400).json({ error: 'Enter a message.' })
  if (blockedAiRequest(question)) return res.status(400).json({ error: 'This request cannot be handled by the infrastructure assistant.' })
  const now = Date.now(), recent = (aiRateLimits.get(req.user.id) || []).filter(at => now - at < 60000)
  if (recent.length >= 12) return res.status(429).json({ error: 'Please wait a moment before sending another request.' })
  aiRateLimits.set(req.user.id, [...recent, now])
  const config = readAiConfig()
  if (config.provider === 'openrouter' && !config.apiKey) return res.status(503).json({ error: 'OpenRouter is not configured yet. Add the key in Admin Panel.' })
  if (config.provider !== 'openrouter' && (!config.endpoint || !config.apiKey)) return res.status(503).json({ error: 'The AI runtime is not configured yet.' })
  const role = workspaceRole(req.user, workspace)
  const nodes = db.vms.filter(vm => vm.workspaceId === workspace.id && vm.status !== 'deleted').map(vm => ({ name: vm.name, template: vm.template, status: vm.status, plan: vm.plan, cpu: vm.cpu, ramGb: vm.ram, diskGb: vm.disk, domain: vm.domain, minecraft: vm.minecraft ? { loader: vm.minecraft.loader, version: vm.minecraft.version, playersOnline: vm.minecraft.playersOnline, maxPlayers: vm.minecraft.maxPlayers, status: vm.minecraft.status } : undefined }))
  const memories = (db.aiMemories || []).filter(item => item.userId === req.user.id && item.workspaceId === workspace.id).slice(-20).map(item => item.content)
  const chat = payload.chatId ? ownedAiChat(req, workspace, clean(payload.chatId)) : null
  if (payload.chatId && !chat) return res.status(404).json({ error: 'Chat not found.' })
  const system = `You are Vyron Copilot, a helpful general-purpose assistant and the infrastructure assistant for Vyron Technologies. Users may ask any lawful general question, including questions unrelated to hosting. Answer those normally and set action to null. Refuse only requests that meaningfully facilitate illegal activity, cyber abuse, credential theft, privacy invasion, fraud, violence, sexual exploitation, trafficking, or evasion of law enforcement. Allow benign education, prevention, defensive security, news, history, and legal high-level discussion even when sensitive topics are mentioned. Vyron Hosting provides isolated KVM nodes on Ubuntu with Mini (0.5 CPU, 2 GB RAM, 20 GB), Basic (1 CPU, 4 GB, 100 GB), Pro (2 CPU, 6 GB, 200 GB), and Enterprise (4 CPU, 12 GB, 500 GB). It supports Ubuntu, Node.js/Nginx, Python and Minecraft templates, managed domains, metrics, files, logs, backups, public SSH through gateway.vyronhosting.com, and Minecraft SRV routing. Never ask for, reveal, transmit or use passwords, API keys, tokens, private keys or internal IPs. Infrastructure actions are restricted to this workspace and always require explicit user confirmation. Current role: ${role}. Current workspace nodes: ${JSON.stringify(nodes)}. User-approved memory: ${JSON.stringify(memories)}. Return ONLY valid JSON: {"answer":"clear helpful answer","action":null,"memory":null} or {"answer":"explain the proposed action and its impact","action":{"type":"diagnostic_command|minecraft_command|start_node|stop_node","node":"exact node name","command":"command when required","reason":"short reason"},"memory":null}. Set memory to one short durable fact only when the user explicitly asks you to remember or save it. Only propose diagnostic_command using one read-only command: uptime, free, df, du, ls, pwd, ps, ss, systemctl status/is-active, journalctl -u, or a bounded tail of application logs. Minecraft commands are limited to list, tps, version, save-all, whitelist list, and say. Never claim an action already ran.`
  try {
    const storedHistory = (chat?.messages || []).filter(item => ['user', 'assistant'].includes(item?.role)).slice(-16)
    const legacyHistory = Array.isArray(payload.history) ? payload.history.slice(-8) : []
    const history = (storedHistory.length ? storedHistory : legacyHistory).filter(item => ['user', 'assistant'].includes(item?.role) && typeof item?.content === 'string').map(item => ({ role: item.role, content: item.content.slice(0, 1800) }))
    const useSearch = config.webSearch !== false && webSearchRequested(question)
    const requestBody = { model: config.model || 'openrouter/free', temperature: 0.2, messages: [{ role: 'system', content: `${system} If web search is used, include concise markdown links in the answer and do not invent citations.` }, ...history, { role: 'user', content: question }] }
    if (config.provider === 'openrouter' && useSearch) requestBody.tools = [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_total_results: 8, search_context_size: 'low' } }]
    let response, body, lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(config.provider === 'openrouter' ? openRouterUrl(config.endpoint) : aiGatewayUrl(config.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}`, ...(config.provider === 'openrouter' ? { 'HTTP-Referer': 'https://app.vyronhosting.com', 'X-OpenRouter-Title': 'Vyron Hosting' } : {}) }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(60_000) })
      body = await response.json().catch(() => ({}))
      if (response.ok) break
      lastError = body.error?.message || `${config.provider} returned HTTP ${response.status}`
      if (requestBody.tools && [400, 404, 422].includes(response.status)) { delete requestBody.tools; continue }
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(lastError)
      await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)))
    }
    const raw = String(body.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '')
    if (!raw.trim()) throw new Error('The selected AI model returned an empty response. Please retry.')
    let parsed
    try { parsed = JSON.parse(raw) }
    catch {
      const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
      if (start >= 0 && end > start) { try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch {} }
      parsed ||= { answer: raw.replace(/^```[a-z]*\s*|\s*```$/gi, ''), action: null, memory: null }
    }
    let proposedAction = null
    if (parsed.action && typeof parsed.action === 'object' && roleRank(role) >= 2) {
      const node = nodes.find(item => item.name === parsed.action.node)
      let command = null
      if (parsed.action.type === 'diagnostic_command') command = safeDiagnosticCommand(parsed.action.command)
      if (parsed.action.type === 'minecraft_command' && node?.template === 'minecraft') command = safeMinecraftCommand(parsed.action.command)
      const validControl = ['start_node', 'stop_node'].includes(parsed.action.type)
      if (node && (command || validControl)) {
        const id = crypto.randomUUID()
        proposedAction = { id, type: parsed.action.type, node: node.name, command, reason: clean(parsed.action.reason).slice(0, 180), expiresAt: now + 5 * 60 * 1000 }
        pendingAiActions.set(id, { ...proposedAction, userId: req.user.id, workspaceId: workspace.id })
      }
    }
    const annotations = body.choices?.[0]?.message?.annotations || []
    const sources = annotations.filter(item => item?.type === 'url_citation' && item.url_citation?.url).slice(0, 8).map(item => ({ title: item.url_citation.title || item.url_citation.url, url: item.url_citation.url }))
    const answer = clean(parsed.answer).slice(0, 4000) || clean(raw).slice(0, 4000) || 'How can I help with your Vyron workspace?'
    let savedMemory = null
    if (typeof parsed.memory === 'string' && /\b(remember|save|memorize|merk(?:e| dir)|speicher)\b/i.test(question)) {
      const content = clean(parsed.memory).replace(/\s+/g, ' ').slice(0, 300)
      if (content) { savedMemory = { id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, content, createdAt: new Date().toISOString() }; db.aiMemories ||= []; db.aiMemories.push(savedMemory) }
    }
    let activeChat = chat
    if (!activeChat) { const stamp = new Date().toISOString(); activeChat = { id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, title: question.slice(0, 52), messages: [{ role: 'assistant', content: aiGreeting }], createdAt: stamp, updatedAt: stamp }; db.aiChats ||= []; db.aiChats.push(activeChat) }
    activeChat.messages ||= []; activeChat.messages.push({ role: 'user', content: question }, { role: 'assistant', content: answer, sources }); activeChat.messages = activeChat.messages.slice(-80); activeChat.updatedAt = new Date().toISOString(); save()
    res.json({ answer, proposedAction, sources, searched: useSearch, chat: publicAiChat(activeChat), memory: savedMemory ? (({ userId, workspaceId, ...item }) => item)(savedMemory) : null })
  } catch (error) { console.error('AI chat failed:', error.message); res.status(502).json({ error: /429|rate|quota|capacity/i.test(error.message) ? 'The free AI provider is busy right now. Please retry in a moment.' : `AI runtime error: ${error.message}` }) }
})

app.post('/v1/ai/actions/:id/execute', requireAuth, async (req, res) => {
  const action = pendingAiActions.get(req.params.id), workspace = activeWorkspace(req.user)
  if (!action || action.expiresAt < Date.now()) { pendingAiActions.delete(req.params.id); return res.status(410).json({ error: 'This action expired. Ask the AI again.' }) }
  if (action.userId !== req.user.id || action.workspaceId !== workspace?.id || roleRank(workspaceRole(req.user, workspace)) < 2) return res.status(403).json({ error: 'You cannot execute this action.' })
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Explicit confirmation is required.' })
  const vm = db.vms.find(item => item.workspaceId === workspace.id && item.name === action.node && item.status !== 'deleted')
  if (!vm) return res.status(404).json({ error: 'Node not found.' })
  pendingAiActions.delete(req.params.id)
  try {
    let result
    if (action.type === 'diagnostic_command') result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/exec`, { method: 'POST', body: JSON.stringify({ command: action.command, cwd: '/root' }) })
    else if (action.type === 'minecraft_command') result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/command`, { method: 'POST', body: JSON.stringify({ command: action.command, rconPassword: vm.minecraft?.rconPassword }) })
    else {
      if (action.type === 'start_node' && !requireStartAvailability(res)) return
      result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/${action.type === 'start_node' ? 'start' : 'stop'}`, { method: 'POST' })
      vm.status = result.status || vm.status
    }
    db.aiAudit ||= []; db.aiAudit.push({ id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, node: vm.name, type: action.type, command: action.command || null, at: new Date().toISOString() }); db.aiAudit = db.aiAudit.slice(-1000); save()
    res.json({ ok: true, result })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

const ownedWebVm = (req, res, id) => {
  const workspace = activeWorkspace(req.user)
  if (workspace && roleRank(workspaceRole(req.user, workspace)) < 2) { res.status(403).json({ error: 'Developer access is required.' }); return null }
  const vm = workspace && db.vms.find(item => item.id === id && item.workspaceId === workspace.id && item.status !== 'deleted')
  if (!vm) res.status(404).json({ error: 'Node not found.' })
  return vm
}
const publicDnsProvider = workspace => {
  const connection = workspace?.dnsProviders?.cloudflare
  return connection ? { provider: 'cloudflare', connected: true, zoneId: connection.zoneId, zoneName: connection.zoneName, tokenHint: connection.tokenHint, connectedAt: connection.connectedAt, tokenStatus: connection.tokenStatus || 'active' } : { provider: null, connected: false }
}
app.get('/v1/dns-providers', requireAuth, (req, res) => res.json({ cloudflare: publicDnsProvider(activeWorkspace(req.user)) }))
app.post('/v1/dns-providers/cloudflare/connect', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user), hostname = clean(req.body.domain).toLowerCase().replace(/\.$/, ''), token = clean(req.body.apiToken)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) return res.status(400).json({ error: 'Enter the domain you want to connect.' })
  if (token.length < 30 || token.length > 200) return res.status(400).json({ error: 'Enter a valid Cloudflare API Token.' })
  try {
    const verification = await customerCloudflareRequest(token, '/user/tokens/verify')
    if (verification?.status !== 'active') return res.status(400).json({ error: `Cloudflare token is ${verification?.status || 'not active'}.` })
    const zone = await findCustomerCloudflareZone(token, hostname)
    if (!zone) return res.status(404).json({ error: 'No active Cloudflare zone matching this domain was found. The token needs Zone Read access.' })
    await customerCloudflareRequest(token, `/zones/${encodeURIComponent(zone.id)}/dns_records?per_page=5`)
    workspace.dnsProviders ||= {}
    workspace.dnsProviders.cloudflare = { zoneId: zone.id, zoneName: zone.name, token: sealCustomerToken(token), tokenHint: `${token.slice(0, 6)}••••${token.slice(-4)}`, tokenStatus: verification.status, connectedAt: new Date().toISOString(), connectedBy: req.user.id }
    save(); recordAudit(req, 'dns.cloudflare.connect', zone.name, { zoneId: zone.id })
    res.json({ cloudflare: publicDnsProvider(workspace) })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.status === 403 ? 'The token needs Zone Read and DNS Edit permissions for this zone.' : error.message })
  }
})
app.delete('/v1/dns-providers/cloudflare', requireAuth, (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  if (workspace.dnsProviders) delete workspace.dnsProviders.cloudflare
  save(); recordAudit(req, 'dns.cloudflare.disconnect', workspace.id)
  res.json({ cloudflare: publicDnsProvider(workspace) })
})
app.post('/v1/domains/:id/enable-cloudflare', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (!workspace || roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  const record = db.domains.find(item => item.id === req.params.id && item.workspaceId === workspace.id)
  if (!record) return res.status(404).json({ error: 'Domain not found.' })
  const connection = workspace.dnsProviders?.cloudflare
  if (!connection) return res.status(409).json({ error: 'Connect Cloudflare before enabling automatic DNS.' })
  try {
    const provisioned = await createCloudflareCustomHostname(record.domain, connection)
    if (!provisioned.dnsManaged || provisioned.customerZone?.id !== connection.zoneId) return res.status(409).json({ error: `The connected Cloudflare zone ${connection.zoneName} does not manage ${record.domain}.` })
    record.dnsProvider = 'cloudflare'
    applyManagedDomainProvisioning(record, provisioned)
    if (record.verifiedAt && record.vmId) {
      const vm = db.vms.find(item => item.id === record.vmId && item.status !== 'deleted')
      if (vm) await assignDomainRecord(record, vm, record.websiteSlot)
    }
    save(); recordAudit(req, 'dns.cloudflare.enable', record.domain, { zoneId: provisioned.customerZone?.id })
    res.json({ domain: record })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
const assignDomainRecord = async (record, vm, requestedSlot = null) => {
  const websiteSlot = vm.template === 'node' && Number.isInteger(Number(requestedSlot)) && Number(requestedSlot) >= 1 && Number(requestedSlot) <= 5 ? Number(requestedSlot) : null
  if (websiteSlot && !vm.websites?.some(item => Number(item.slot) === websiteSlot)) throw Object.assign(new Error(`Website /${websiteSlot} is not active on this node yet.`), { status: 409 })
  if (record.minecraftSrvRecord) {
    await cloudflareRequest(`/zones/${encodeURIComponent(record.minecraftSrvRecord.zoneId)}/dns_records/${encodeURIComponent(record.minecraftSrvRecord.id)}`, { method: 'DELETE' }).catch(() => {})
    delete record.minecraftSrvRecord
  }
  if (record.vmId && (record.vmId !== vm.id || Number(record.websiteSlot || 0) !== Number(websiteSlot || 0))) await agentRequest(`/v1/domains/${encodeURIComponent(record.domain)}`, { method: 'DELETE' }).catch(() => {})
  await removeAssignedDomainDns(record)
  for (const previous of db.domains.filter(item => item.id !== record.id && item.vmId === vm.id && Number(item.websiteSlot || 0) === Number(websiteSlot || 0))) {
    await agentRequest(`/v1/domains/${encodeURIComponent(previous.domain)}`, { method: 'DELETE' }).catch(() => {})
    await removeAssignedDomainDns(previous)
    previous.vmId = null; previous.status = 'verified'; delete previous.assignedAt; delete previous.websiteSlot
  }
  await agentRequest('/v1/domains', { method: 'POST', body: JSON.stringify({ hostname: record.domain, node: vm.name, pathPrefix: websiteSlot ? `/${websiteSlot}` : '' }) })
  if (['node', 'nginx'].includes(vm.template)) await ensureCustomTunnelIngress(record.domain)
  if (vm.template === 'minecraft' && record.dnsProvider === 'cloudflare' && record.dnsManaged) record.minecraftSrvRecord = await ensureMinecraftCustomDomainSrv(record.domain)
  if (['node', 'nginx'].includes(vm.template) && record.dnsProvider === 'cloudflare' && record.dnsManaged) {
    const assignedDns = await ensureAssignedWebDomainDns(record.domain)
    if (assignedDns) record.assignedDnsRecord = assignedDns
  }
  record.vmId = vm.id; record.status = 'active'; record.assignedAt = new Date().toISOString()
  if (websiteSlot) record.websiteSlot = websiteSlot
  else delete record.websiteSlot
  delete record.pendingVmId; delete record.pendingWebsiteSlot
  return record
}
const completeDomainVerification = async (record, workspace) => {
  record.verifiedAt ||= new Date().toISOString()
  const target = record.pendingVmId && db.vms.find(item => item.id === record.pendingVmId && item.workspaceId === workspace?.id && item.status !== 'deleted')
  if (target) await assignDomainRecord(record, target, record.pendingWebsiteSlot)
  else record.status = record.vmId ? 'active' : 'verified'
  return record
}
app.post('/v1/domains', requireAuth, async (req, res) => {
  const domain = clean(req.body.domain).toLowerCase().replace(/\.$/, '')
  const provider = clean(req.body.provider || 'manual').toLowerCase()
  const workspace = activeWorkspace(req.user)
  if (!workspace) return res.status(409).json({ error: 'Create a workspace first.' })
  if (roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return res.status(400).json({ error: 'Enter a valid domain name.' })
  if (domain.endsWith('.vyronhosting.com')) return res.status(400).json({ error: 'Vyron service hostnames are managed automatically.' })
  if (db.domains.some(item => item.domain === domain)) return res.status(409).json({ error: 'That domain is already connected.' })
  const requestedVmId = clean(req.body.vmId)
  const requestedSlot = req.body.websiteSlot === null || req.body.websiteSlot === '' || req.body.websiteSlot === undefined ? null : Number(req.body.websiteSlot)
  const targetVm = requestedVmId ? ownedWebVm(req, res, requestedVmId) : null
  if (requestedVmId && !targetVm) return
  if (requestedSlot !== null && (!targetVm || targetVm.template !== 'node' || !Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > 5)) return res.status(400).json({ error: 'Choose a valid Node.js website slot.' })
  if (requestedSlot && !targetVm.websites?.some(item => Number(item.slot) === requestedSlot)) return res.status(409).json({ error: `Activate website /${requestedSlot} before assigning a domain to it.` })
  try {
    const connection = provider === 'cloudflare' ? workspace.dnsProviders?.cloudflare : null
    if (provider === 'cloudflare' && !connection) return res.status(409).json({ error: 'Connect Cloudflare before adding this domain automatically.' })
    if (!['manual', 'cloudflare'].includes(provider)) return res.status(400).json({ error: 'Choose a supported DNS provider.' })
    const provisioned = await createCloudflareCustomHostname(domain, connection)
    if (provider === 'cloudflare' && (!provisioned.dnsManaged || provisioned.customerZone?.id !== connection.zoneId)) return res.status(409).json({ error: `The connected Cloudflare zone ${connection.zoneName} does not manage this domain.` })
    const record = { id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, vmId: null, pendingVmId: targetVm?.id || null, pendingWebsiteSlot: requestedSlot, domain, dnsProvider: provider, status: 'pending_verification', verificationToken: crypto.randomBytes(18).toString('hex'), createdAt: new Date().toISOString() }
    applyManagedDomainProvisioning(record, provisioned)
    db.domains.push(record); save(); res.status(201).json({ domain: record })
  } catch (error) {
    const message = error.status === 401 ? 'Cloudflare rejected the configured credential. Replace it with a valid API Token, or save the Global API Key together with cloudflare-api-email.' : error.message
    res.status(error.status || 502).json({ error: message })
  }
})
app.post('/v1/domains/:id/verify', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  const record = db.domains.find(item => item.id === req.params.id && item.workspaceId === workspace?.id)
  if (!record) return res.status(404).json({ error: 'Domain not found.' })
  try {
    if (record.cloudflareHostnameId) {
      const zoneId = await getSaasZoneId()
      const result = await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(record.cloudflareHostnameId)}`)
      record.cloudflareStatus = result.status; record.sslStatus = result.ssl?.status || record.sslStatus
      if (!['active', 'provisioned'].includes(result.status)) { save(); return res.status(409).json({ error: `Cloudflare is still validating this domain (${result.status}). DNS may need a few minutes to propagate.` }) }
      await completeDomainVerification(record, workspace); save(); return res.json({ domain: record })
    }
    const recordName = `_vyron-verification.${record.domain}`
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(recordName)}&type=TXT`, { headers: { Accept: 'application/dns-json' } })
    if (!response.ok) throw new Error(`DNS resolver returned HTTP ${response.status}`)
    const body = await response.json()
    const expected = `vyron-verification=${record.verificationToken}`
    const answers = (body.Answer || []).filter(answer => answer.type === 16).map(answer => String(answer.data || '').replace(/^"|"$/g, '').replace(/"\s+"/g, ''))
    if (!answers.includes(expected)) return res.status(409).json({ error: `TXT record not found yet. Add ${recordName} and try again after DNS has propagated.` })
    await completeDomainVerification(record, workspace); save(); res.json({ domain: record })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.patch('/v1/domains/:id', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (roleRank(workspaceRole(req.user, workspace)) < 2) return res.status(403).json({ error: 'Developer access is required.' })
  const record = db.domains.find(item => item.id === req.params.id && item.workspaceId === workspace?.id)
  if (!record) return res.status(404).json({ error: 'Domain not found.' })
  if (!record.verifiedAt) return res.status(409).json({ error: 'Verify the domain ownership TXT record first.' })
  const vm = ownedWebVm(req, res, clean(req.body.vmId)); if (!vm) return
  const websiteSlot = req.body.websiteSlot === null || req.body.websiteSlot === '' || req.body.websiteSlot === undefined ? null : Number(req.body.websiteSlot)
  try {
    await assignDomainRecord(record, vm, websiteSlot); save(); res.json({ domain: record })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/domains/:id/unassign', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (roleRank(workspaceRole(req.user, workspace)) < 2) return res.status(403).json({ error: 'Developer access is required.' })
  const record = db.domains.find(item => item.id === req.params.id && item.workspaceId === workspace?.id)
  if (!record) return res.status(404).json({ error: 'Domain not found.' })
  if (record.vmId) await agentRequest(`/v1/domains/${encodeURIComponent(record.domain)}`, { method: 'DELETE' }).catch(() => {})
  await removeAssignedDomainDns(record)
  if (record.minecraftSrvRecord) {
    await cloudflareRequest(`/zones/${encodeURIComponent(record.minecraftSrvRecord.zoneId)}/dns_records/${encodeURIComponent(record.minecraftSrvRecord.id)}`, { method: 'DELETE' }).catch(() => {})
    delete record.minecraftSrvRecord
  }
  record.vmId = null; record.status = record.verifiedAt ? 'verified' : 'pending_verification'; delete record.assignedAt; delete record.websiteSlot
  save(); res.json({ domain: record })
})
app.delete('/v1/domains/:id', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required.' })
  const index = db.domains.findIndex(item => item.id === req.params.id && item.workspaceId === workspace?.id)
  if (index < 0) return res.status(404).json({ error: 'Domain not found.' })
  const [record] = db.domains.splice(index, 1)
  try { await agentRequest(`/v1/domains/${encodeURIComponent(record.domain)}`, { method: 'DELETE' }) } catch {}
  if (record.cloudflareHostnameId) {
    try { const zoneId = await getSaasZoneId(); await cloudflareRequest(`/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(record.cloudflareHostnameId)}`, { method: 'DELETE' }) } catch {}
  }
  for (const managed of record.managedDnsRecords || []) {
    try {
      const connection = record.dnsProvider === 'cloudflare' ? workspace.dnsProviders?.cloudflare : null
      if (connection?.token) await customerCloudflareRequest(openCustomerToken(connection.token), `/zones/${encodeURIComponent(managed.zoneId)}/dns_records/${encodeURIComponent(managed.id)}`, { method: 'DELETE' })
      else await cloudflareRequest(`/zones/${encodeURIComponent(managed.zoneId)}/dns_records/${encodeURIComponent(managed.id)}`, { method: 'DELETE' })
    } catch {}
  }
  if (record.minecraftSrvRecord) {
    try { await cloudflareRequest(`/zones/${encodeURIComponent(record.minecraftSrvRecord.zoneId)}/dns_records/${encodeURIComponent(record.minecraftSrvRecord.id)}`, { method: 'DELETE' }) } catch {}
  }
  save(); res.json({ ok: true })
})
app.get('/v1/vms/:name/logs', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (!['node', 'nginx'].includes(vm.template)) return res.status(400).json({ error: 'Live logs are available for web nodes only.' })
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node to view live logs.' })
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/logs?lines=${encodeURIComponent(req.query.lines || 200)}`)) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/v1/network/private', requireAuth, requireAdmin, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  const nodes = workspace
    ? db.vms.filter(vm => vm.userId === req.user.id && vm.workspaceId === workspace.id && vm.status !== 'deleted').map(nodeConnections)
    : []
  let route = null, error = null
  if (cloudflareConfigured()) {
    try { route = await getCloudflarePrivateRoute() } catch (cause) { error = cause.message }
  }
  res.json({
    provider: 'Cloudflare Zero Trust',
    configured: cloudflareConfigured(),
    network: privateNetwork,
    connector: 'Vyron Servers',
    teamName: cloudflareTeamName || null,
    route: route ? { id: route.id, network: route.network, tunnelId: route.tunnel_id, comment: route.comment, createdAt: route.created_at, status: 'active' } : null,
    status: route ? 'active' : cloudflareConfigured() ? 'pending' : 'not_configured',
    error,
    requiresWarp: true,
    nodes
  })
})
app.post('/v1/admin/network/cloudflare/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await ensureCloudflarePrivateRoute()
    res.status(result.created ? 201 : 200).json({
      created: result.created,
      status: 'active',
      network: result.route.network,
      route: { id: result.route.id, tunnelId: result.route.tunnel_id, comment: result.route.comment, createdAt: result.route.created_at }
    })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
const provisionPaidOrder = async order => {
  if (order.vmId) return db.vms.find(vm => vm.id === order.vmId)
  const availability = creationAvailability()
  if (!availability.available) throw Object.assign(new Error(availability.reason), { status: 503, availability })
  const pending = order.pending
  if (!pending) throw Object.assign(new Error('This order no longer contains provisioning details.'), { status: 409 })
  const job = await agentRequest('/v1/vms', { method: 'POST', body: JSON.stringify({ name: pending.name, template: pending.template, resources: { cpu: pending.cpu, ram: pending.ram, disk: pending.disk } }) })
  const location = configuredLocations().find(item => item.status === 'operational')
  const vm = { id: crypto.randomUUID(), userId: order.userId, workspaceId: order.workspaceId, orderId: order.id, jobId: job.id, locationId: location?.id || null, name: pending.name, domain: `${pending.name}.vyronhosting.com`, template: pending.template, plan: order.plan, cpu: pending.cpu, ram: pending.ram, disk: pending.disk, status: job.state, desiredState: 'running', createdAt: new Date().toISOString() }
  if (pending.template === 'minecraft') vm.minecraft = { ...pending.minecraft, playersOnline: 0, players: [], port: 25565, status: 'queued', stage: 'Creating virtual machine', rconPassword: crypto.randomBytes(24).toString('base64url') }
  if (pending.uploadPath) {
    vm.uploadPath = pending.uploadPath
    vm.deployment = { status: 'queued', fileName: pending.archiveName, entryFile: pending.entryFile, uploadedAt: new Date().toISOString() }
  }
  if (pending.github?.repository) {
    vm.github = pending.github
    vm.deployment = { status: 'queued', source: 'github', fileName: pending.github.repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''), entryFile: pending.entryFile, repository: pending.github.repository, branch: pending.github.branch || null, linkedAt: new Date().toISOString() }
  }
  db.vms.push(vm)
  createNodeEvent(vm, 'node_queued', 'Node creation queued', `${pending.template} · ${pending.cpu} vCPU · ${pending.ram} GB RAM · ${pending.disk} GB storage${location ? ` · ${location.name}` : ''}`)
  order.vmId = vm.id
  delete order.pending
  save()
  return vm
}
const applyPaidUpgrade = async order => {
  const pending = order.pendingUpgrade
  const vm = db.vms.find(item => item.id === order.targetVmId && item.userId === order.userId && item.status !== 'deleted')
  if (!vm) throw Object.assign(new Error('The node for this upgrade no longer exists.'), { status: 404 })
  if (order.upgradeAppliedAt) return vm
  if (!pending) throw Object.assign(new Error('This order no longer contains upgrade details.'), { status: 409 })
  if (vm.cpu >= pending.cpu && vm.ram >= pending.ram && vm.disk >= pending.disk) {
    order.upgradeAppliedAt = new Date().toISOString(); delete order.pendingUpgrade; delete order.paymentError; save()
    return vm
  }
  const previous = { cpu: vm.cpu, ram: vm.ram, disk: vm.disk }
  const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/upgrade`, { method: 'POST', body: JSON.stringify(pending) })
  vm.cpu = pending.cpu; vm.ram = pending.ram; vm.disk = pending.disk; vm.status = result.status || vm.status
  order.upgradeAppliedAt = new Date().toISOString(); delete order.pendingUpgrade; delete order.paymentError
  createNodeEvent(vm, 'billing_upgrade', 'Node resources upgraded', `${previous.cpu} → ${vm.cpu} vCPU · ${previous.ram} → ${vm.ram} GB RAM · ${previous.disk} → ${vm.disk} GB storage`)
  save()
  return { ...vm, previous, upgradeJobId: result.jobId }
}
const activeStripeCompletions = new Map()
const completeStripeOrder = async (order, session) => {
  if (!order || !session || session.id !== order.stripeSessionId || session.metadata?.orderId !== order.id || session.client_reference_id !== order.id) throw Object.assign(new Error('Stripe checkout does not match this order.'), { status: 400 })
  if (session.payment_status !== 'paid' || session.status !== 'complete' || session.currency !== 'eur' || Number(session.amount_total) !== Math.round(Number(order.total) * 100)) throw Object.assign(new Error('Stripe has not confirmed the expected payment.'), { status: 409 })
  if (activeStripeCompletions.has(order.id)) return activeStripeCompletions.get(order.id)
  const task = (async () => {
    if (order.status !== 'paid') {
      order.status = 'paid'; order.paidAt = new Date().toISOString(); order.stripePaymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null
      convertReferral(order.userId); save()
    }
    const vm = order.kind === 'upgrade' ? await applyPaidUpgrade(order) : await provisionPaidOrder(order)
    return { order, vm }
  })().finally(() => activeStripeCompletions.delete(order.id))
  activeStripeCompletions.set(order.id, task)
  return task
}
const reconcilePaidUpgrades = async () => {
  const pending = db.orders.filter(order => order.kind === 'upgrade' && order.status === 'paid' && order.pendingUpgrade && !order.upgradeAppliedAt)
  for (const order of pending) {
    if (activeStripeCompletions.has(order.id)) continue
    const task = (async () => ({ order, vm: await applyPaidUpgrade(order) }))()
      .catch(error => { order.paymentError = error.message; save(); console.error(`Upgrade reconciliation failed for ${order.id}: ${error.message}`); return null })
      .finally(() => activeStripeCompletions.delete(order.id))
    activeStripeCompletions.set(order.id, task)
    await task
  }
}
const upgradeReconciliationTimer = setInterval(() => void reconcilePaidUpgrades(), 60_000)
upgradeReconciliationTimer.unref()
setTimeout(() => void reconcilePaidUpgrades(), 7_000).unref()
app.get('/v1/payments/stripe/config', requireAuth, (_, res) => res.json({ provider: 'stripe', mode: 'test', configured: stripeTestConfigured(), publishableKey: stripeTestConfigured() ? stripePublishableKey : null, embedded: true }))
app.post('/v1/payments/stripe/confirm', requireAuth, async (req, res) => {
  if (!stripeTestConfigured() || !stripe) return res.status(503).json({ error: 'Stripe test checkout is not configured yet.' })
  const order = db.orders.find(item => item.id === clean(req.body.orderId) && item.userId === req.user.id)
  if (!order || !order.stripeSessionId) return res.status(404).json({ error: 'Stripe order not found.' })
  if (clean(req.body.sessionId) !== order.stripeSessionId) return res.status(400).json({ error: 'Stripe session does not match this order.' })
  try {
    const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId)
    const result = await completeStripeOrder(order, session)
    recordAudit(req, order.kind === 'upgrade' ? 'billing.upgrade.captured' : 'billing.payment.captured', order.id, { provider: 'stripe-test', total: order.total, node: result.vm.name })
    res.json({ order: { ...order, pending: undefined, pendingUpgrade: undefined }, vm: { ...result.vm, userId: undefined, uploadPath: undefined } })
  } catch (error) { order.paymentError = error.message; save(); res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/payments/stripe/cancel', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe test checkout is not configured yet.' })
  const order = db.orders.find(item => item.id === clean(req.body.orderId) && item.userId === req.user.id)
  if (!order || clean(req.body.sessionId) !== order.stripeSessionId) return res.status(404).json({ error: 'Stripe order not found.' })
  if (order.status === 'paid') return res.status(409).json({ error: 'A completed payment cannot be cancelled here.' })
  try { await stripe.checkout.sessions.expire(order.stripeSessionId) } catch (error) { if (error?.code !== 'checkout_session_not_open') return res.status(502).json({ error: error.message }) }
  order.status = 'cancelled'; order.cancelledAt = new Date().toISOString()
  if (order.pending?.uploadPath) { fs.rmSync(order.pending.uploadPath, { force: true }); order.pending.uploadPath = null }
  save(); recordAudit(req, 'billing.checkout.cancelled', order.id, { provider: 'stripe-test' }); res.json({ cancelled: true })
})
app.post('/v1/webhooks/stripe', async (req, res) => {
  if (!stripe || !stripeWebhookSecret.startsWith('whsec_')) return res.status(503).json({ error: 'Stripe webhook is not configured.' })
  let event
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], stripeWebhookSecret)
  } catch (error) {
    return res.status(400).json({ error: `Webhook signature error: ${error.message}` })
  }
  try {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const session = event.data.object
      const order = db.orders.find(item => item.id === session.metadata?.orderId && item.stripeSessionId === session.id)
      if (order) {
        await completeStripeOrder(order, session)
        if (!order.stripeDiscordNotifiedAt) {
          const notification = await sendStripeDiscordWebhook(event, order, 'succeeded')
          if (notification.sent) { order.stripeDiscordNotifiedAt = new Date().toISOString(); save() }
        }
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object
      const order = db.orders.find(item => item.id === session.metadata?.orderId && item.stripeSessionId === session.id)
      if (order && order.stripeDiscordFailureEventId !== event.id) {
        order.paymentError = 'Stripe reported an asynchronous payment failure.'
        const notification = await sendStripeDiscordWebhook(event, order, 'failed')
        if (notification.sent) order.stripeDiscordFailureEventId = event.id
        save()
      }
    }
    res.json({ received: true })
  } catch (error) {
    createAdminNotification('payment_failure', 'Stripe payment processing failed', error.message, { provider: 'stripe-test', eventId: event.id })
    res.status(400).json({ error: `Webhook error: ${error.message}` })
  }
})
app.post('/v1/coupons/validate', requireAuth, (req, res) => {
  const coupon = coupons[clean(req.body.code).toUpperCase()]
  const planId = clean(req.body.plan).toLowerCase()
  if (!coupon?.active) return res.status(404).json({ error: 'Invalid coupon.' })
  if (!couponAllowedForUser(coupon.code, req.user.id)) return res.status(404).json({ error: 'Invalid coupon.' })
  if (!coupon.plans.includes(planId)) return res.status(400).json({ error: `${coupon.code} is not valid for this plan.` })
  if (coupon.firstMonthOnly && couponAlreadyUsed(coupon.code, req.user.id)) return res.status(409).json({ error: `${coupon.code} has already been used for this account's first month.` })
  return res.json({ code: coupon.code, percent: coupon.percent, firstMonthOnly: coupon.firstMonthOnly })
})
app.get('/v1/minecraft/versions', requireAuth, (_, res) => res.json({ loaders: ['paper', 'vanilla', 'purpur', 'fabric', 'forge', 'folia'], versions: ['1.21.11', '1.21.10', '1.21.8', '1.21.4', '1.20.6', '1.20.4', '1.20.1'], recommended: '1.21.11', java: 21 }))
const modrinthHeaders = { 'User-Agent': 'VyronHosting/1.0 (https://vyronhosting.com; support@vyronhosting.com)' }
const modrinthRequest = async pathname => {
  const response = await fetch(`https://api.modrinth.com/v2${pathname}`, { headers: modrinthHeaders })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.description || body.error || `Modrinth returned HTTP ${response.status}`), { status: response.status === 429 ? 429 : 502 })
  return body
}
const modrinthLoader = loader => loader === 'fabric' ? { kind: 'mod', loaders: ['fabric'], category: 'fabric', folder: 'mods' } : loader === 'forge' ? { kind: 'mod', loaders: ['forge'], category: 'forge', folder: 'mods' } : ['paper', 'purpur'].includes(loader) ? { kind: 'plugin', loaders: ['paper', 'purpur', 'spigot', 'bukkit'], category: 'paper', folder: 'plugins' } : loader === 'folia' ? { kind: 'plugin', loaders: ['folia'], category: 'folia', folder: 'plugins' } : null
app.get('/v1/vms/:name/minecraft/extensions/search', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  const query = clean(req.query.query).slice(0, 80), loader = clean(vm.minecraft?.loader).toLowerCase(), version = clean(vm.minecraft?.version), config = modrinthLoader(loader)
  const type = ['plugin', 'mod', 'modpack'].includes(clean(req.query.type).toLowerCase()) ? clean(req.query.type).toLowerCase() : (config?.kind || 'plugin')
  const offset = Math.min(10000, Math.max(0, Number(req.query.offset) || 0))
  const typeFacet = type === 'modpack' ? 'project_type:modpack' : `all_project_types:${type}`
  // Do not hide projects just because their newest search entry does not target the
  // node's exact game version. Compatibility is shown per card and per release.
  const facets = [[typeFacet], ['environment:server_only', 'environment:server_only_client_optional', 'environment:dedicated_server_only', 'environment:client_and_server', 'environment:client_or_server', 'environment:client_or_server_prefers_both']]
  try {
    const result = await modrinthRequest(`/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=downloads&offset=${offset}&limit=48`)
    res.json({
      kind: type,
      loader,
      version,
      offset,
      total: result.total_hits || 0,
      results: (result.hits || []).map(item => {
        const categories = item.categories || []
        const supportsLoader = type === config?.kind && config.loaders.some(value => categories.includes(value))
        return { id: item.project_id, slug: item.slug, type, installable: Boolean(supportsLoader && (item.versions || []).includes(version)), compatible: Boolean(supportsLoader && (item.versions || []).includes(version)), title: item.title, description: item.description, author: item.author, downloads: item.downloads, iconUrl: /^https:\/\/cdn\.modrinth\.com\//.test(item.icon_url || '') ? item.icon_url : null, categories: (item.display_categories || categories).slice(0, 8), supportedVersions: (item.versions || []).slice(-12).reverse() }
      })
    })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/v1/vms/:name/minecraft/extensions', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  const config = modrinthLoader(clean(vm.minecraft?.loader).toLowerCase())
  if (!config) return res.json({ kind: 'unsupported', files: [] })
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/extensions?loader=${encodeURIComponent(vm.minecraft.loader)}`)) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/v1/vms/:name/minecraft/extensions/:projectId', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  const projectId = clean(req.params.projectId), loader = clean(vm.minecraft?.loader).toLowerCase(), gameVersion = clean(vm.minecraft?.version), config = modrinthLoader(loader)
  const type = ['plugin', 'mod', 'modpack'].includes(clean(req.query.type).toLowerCase()) ? clean(req.query.type).toLowerCase() : (config?.kind || 'plugin')
  if (!/^[A-Za-z0-9]{3,64}$/.test(projectId)) return res.status(400).json({ error: 'Invalid Modrinth project.' })
  try {
    const project = await modrinthRequest(`/project/${encodeURIComponent(projectId)}`)
    const versionQuery = new URLSearchParams({ game_versions: JSON.stringify([gameVersion]), include_changelog: 'false' })
    if (type !== 'modpack' && config?.loaders?.length) versionQuery.set('loaders', JSON.stringify(config.loaders))
    const versions = await modrinthRequest(`/project/${encodeURIComponent(projectId)}/version?${versionQuery}`)
    const safeUrl = value => /^https:\/\/(cdn\.)?modrinth\.com\//.test(value || '') ? value : null
    res.json({
      id: project.id, slug: project.slug, type, title: project.title, description: project.description, body: clean(project.body).slice(0, 30000), downloads: project.downloads, followers: project.followers,
      iconUrl: safeUrl(project.icon_url), categories: (project.categories || []).slice(0, 20), license: project.license?.name || project.license?.id || null,
      gallery: (project.gallery || []).map(item => ({ url: safeUrl(item.url), title: clean(item.title), description: clean(item.description), featured: Boolean(item.featured) })).filter(item => item.url).slice(0, 12),
      gameVersion, loader, installable: type !== 'modpack' && versions.length > 0,
      versions: versions.slice(0, 100).map(item => { const file = item.files?.find(entry => entry.primary && entry.filename?.endsWith('.jar')) || item.files?.find(entry => entry.filename?.endsWith('.jar')); return { id: item.id, name: item.name, versionNumber: item.version_number, versionType: item.version_type, datePublished: item.date_published, downloads: item.downloads, gameVersions: item.game_versions || [], loaders: item.loaders || [], file: file ? { filename: file.filename, size: file.size } : null } }).filter(item => item.file)
    })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/minecraft/extensions/install', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  if (vm.status !== 'running' || vm.minecraft?.status !== 'running') return res.status(409).json({ error: 'Start the Minecraft server before installing an extension.' })
  const projectId = clean(req.body.projectId), requestedVersionId = clean(req.body.versionId), loader = clean(vm.minecraft.loader).toLowerCase(), gameVersion = clean(vm.minecraft.version), config = modrinthLoader(loader)
  if (!config || !/^[A-Za-z0-9]{3,64}$/.test(projectId)) return res.status(400).json({ error: 'Invalid Modrinth project.' })
  if (requestedVersionId && !/^[A-Za-z0-9]{3,64}$/.test(requestedVersionId)) return res.status(400).json({ error: 'Invalid Modrinth version.' })
  try {
    const resolved = [], seenProjects = new Set(), seenVersions = new Set()
    const resolveProject = async (dependencyProjectId, requestedVersionId = null) => {
      if (resolved.length >= 20) throw new Error('This extension has too many required dependencies.')
      let release
      if (requestedVersionId) {
        if (seenVersions.has(requestedVersionId)) return
        release = await modrinthRequest(`/version/${encodeURIComponent(requestedVersionId)}`); seenVersions.add(requestedVersionId)
        if (dependencyProjectId === projectId && release.project_id !== projectId) throw new Error('The selected version does not belong to this project.')
        if (dependencyProjectId === projectId && (!(release.game_versions || []).includes(gameVersion) || !(release.loaders || []).some(value => config.loaders.includes(value)))) throw new Error(`The selected release is not compatible with ${loader} ${gameVersion}.`)
      } else {
        if (seenProjects.has(dependencyProjectId)) return
        const versions = await modrinthRequest(`/project/${encodeURIComponent(dependencyProjectId)}/version?loaders=${encodeURIComponent(JSON.stringify(config.loaders))}&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}&include_changelog=false`)
        release = versions.find(item => item.version_type === 'release') || versions[0]
      }
      if (!release) throw new Error(`No compatible ${gameVersion} version is available for this extension.`)
      seenProjects.add(release.project_id || dependencyProjectId)
      const file = release.files?.find(item => item.primary && item.filename?.endsWith('.jar')) || release.files?.find(item => item.filename?.endsWith('.jar'))
      if (!file || !/^https:\/\/cdn\.modrinth\.com\//.test(file.url || '') || !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 || '')) throw new Error('Modrinth did not provide a verified JAR file.')
      resolved.push({ projectId: release.project_id, versionId: release.id, version: release.version_number, filename: file.filename, url: file.url, sha512: file.hashes.sha512 })
      for (const dependency of release.dependencies || []) if (dependency.dependency_type === 'required' && (dependency.version_id || dependency.project_id)) await resolveProject(dependency.project_id, dependency.version_id)
    }
    await resolveProject(projectId, requestedVersionId || null)
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/extensions/install`, { method: 'POST', body: JSON.stringify({ loader, files: resolved }) })
    vm.minecraft.extensions ||= []
    for (const item of resolved) vm.minecraft.extensions = [...vm.minecraft.extensions.filter(existing => existing.projectId !== item.projectId), { projectId: item.projectId, versionId: item.versionId, version: item.version, filename: item.filename, installedAt: new Date().toISOString() }]
    save(); recordAudit(req, 'minecraft.extension.install', vm.name, { projectId, installed: result.installed?.map(item => item.filename) }); createNodeEvent(vm, 'minecraft_extension_installed', 'Minecraft extension installed', `${resolved[0].filename}${resolved.length > 1 ? ` with ${resolved.length - 1} required dependencies` : ''}`)
    res.status(201).json({ ...result, extensions: vm.minecraft.extensions })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.delete('/v1/vms/:name/minecraft/extensions/:filename', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  const filename = clean(req.params.filename)
  if (!/^[A-Za-z0-9][A-Za-z0-9._+ -]{0,159}\.jar$/.test(filename)) return res.status(400).json({ error: 'Invalid extension filename.' })
  try {
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/extensions/${encodeURIComponent(filename)}`, { method: 'DELETE', body: JSON.stringify({ loader: vm.minecraft.loader }) })
    vm.minecraft.extensions = (vm.minecraft.extensions || []).filter(item => item.filename !== filename); save(); recordAudit(req, 'minecraft.extension.remove', vm.name, { filename }); createNodeEvent(vm, 'minecraft_extension_removed', 'Minecraft extension removed', filename, 'warning')
    res.json(result)
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/webhooks/github', (req, res) => {
  const signature = String(req.headers['x-hub-signature-256'] || '')
  const repository = clean(req.body?.repository?.html_url || req.body?.repository?.clone_url).replace(/\.git$/, '').replace(/\/$/, '')
  const candidates = db.vms.filter(vm => vm.github?.repository?.replace(/\.git$/, '').replace(/\/$/, '') === repository && vm.github.webhookSecret)
  const node = candidates[0]
  if (!node || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return res.status(401).json({ error: 'Invalid GitHub webhook signature.' })
  const expected = crypto.createHmac('sha256', node.github.webhookSecret).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest('hex')
  const supplied = signature.slice(7)
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) return res.status(401).json({ error: 'Invalid GitHub webhook signature.' })
  if (req.headers['x-github-event'] !== 'push') return res.json({ ignored: true })
  if (node.github.autoDeploy === false) return res.json({ ignored: true, reason: 'Automatic deployments are disabled.' })
  const deliveryId = clean(req.headers['x-github-delivery'])
  if (deliveryId && node.github.lastDeliveryId === deliveryId) return res.json({ ignored: true, reason: 'Duplicate delivery.' })
  if (node.status !== 'running') return res.status(409).json({ error: 'Node must be running before redeploying.' })
  node.github.lastDeliveryId = deliveryId || null
  node.deployment = { ...node.deployment, status: 'queued', requestedAt: new Date().toISOString(), trigger: 'github_push' }
  save(); createNodeEvent(node, 'github_push', 'GitHub push received', `${req.body?.head_commit?.message || 'A new commit'} · ${req.body?.ref || node.github.branch || 'default branch'}`); startNodeDeployment(node)
  res.status(202).json({ accepted: true, node: node.name })
})
app.post('/v1/orders', requireAuth, async (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (!workspace) return res.status(409).json({ error: 'Create a workspace first.' })
  if (roleRank(workspaceRole(req.user, workspace)) < 3) return res.status(403).json({ error: 'Workspace administrator access is required to create nodes and orders.' })
  const plan = plans[clean(req.body.plan)], name = clean(req.body.name).toLowerCase(), template = clean(req.body.template || 'ubuntu'), code = clean(req.body.coupon).toUpperCase(), coupon = code ? coupons[code] : null
  if (!plan) return res.status(400).json({ error: 'Invalid plan.' })
  const availability = creationAvailability()
  if (!availability.available) return res.status(503).json({ error: availability.reason, availability })
  let capacity
  try {
    capacity = await agentRequest('/v1/capacity')
    const missing = ['cpu', 'ram', 'disk'].filter(key => Number(plan[key] || 0) > Number(capacity.available?.[key] || 0))
    if (missing.length) return res.status(409).json({ error: `The ${plan.name} plan is currently unavailable because server capacity is full (${missing.join(', ')}). Choose a smaller plan or try again later.`, capacity })
  } catch (error) {
    return res.status(503).json({ error: 'Capacity could not be verified. Please try again in a moment.' })
  }
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(name)) return res.status(400).json({ error: 'Node name must be 3–32 characters.' })
  if (RESERVED_HOSTNAMES.has(name)) return res.status(409).json({ error: 'This hostname is reserved by Vyron Technologies.' })
  if (!['ubuntu', 'node', 'nginx', 'python', 'minecraft'].includes(template)) return res.status(400).json({ error: 'Invalid template.' })
  if (db.vms.some(v => v.name === name && v.status !== 'deleted')) return res.status(409).json({ error: 'This node name is already taken.' })
  const needsProject = ['node', 'nginx'].includes(template)
  const source = clean(req.body.source || 'upload').toLowerCase()
  const archiveName = clean(req.body.archive?.name)
  const archiveData = String(req.body.archive?.data || '')
  const entryFile = clean(req.body.entryFile).replaceAll('\\', '/').replace(/^\/+/, '')
  const repository = clean(req.body.github?.repository).replace(/\/+$/, ''), branch = clean(req.body.github?.branch)
  if (needsProject && !['upload', 'github'].includes(source)) return res.status(400).json({ error: 'Choose ZIP upload or GitHub.' })
  if (needsProject && source === 'upload' && (!archiveName.toLowerCase().endsWith('.zip') || !archiveData)) return res.status(400).json({ error: 'Upload a ZIP project for this template.' })
  if (needsProject && source === 'github' && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) return res.status(400).json({ error: 'Enter a valid public GitHub repository URL.' })
  if (needsProject && (!/^[A-Za-z0-9._/-]{1,240}$/.test(entryFile) || entryFile.split('/').some(part => !part || part === '..'))) return res.status(400).json({ error: 'Choose a valid project start file.' })
  if (template === 'node' && !/\.(?:js|mjs|cjs)$/i.test(entryFile)) return res.status(400).json({ error: 'Node.js deployments require a .js, .mjs or .cjs start file.' })
  if (template === 'nginx' && !/\.html?$/i.test(entryFile)) return res.status(400).json({ error: 'Nginx deployments require an HTML main page.' })
  if (branch && !/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) return res.status(400).json({ error: 'Invalid Git branch.' })
  if (archiveData && (archiveData.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(archiveData))) return res.status(413).json({ error: 'The ZIP upload is invalid or too large.' })
  const archiveBytes = archiveData ? Buffer.from(archiveData, 'base64') : null
  if (archiveBytes && (archiveBytes.length > 20 * 1024 * 1024 || archiveBytes[0] !== 0x50 || archiveBytes[1] !== 0x4b)) return res.status(400).json({ error: 'The upload must be a ZIP file up to 20 MB.' })
  const minecraft = req.body.minecraft || {}
  if (template === 'minecraft' && !['paper', 'vanilla', 'purpur', 'fabric', 'forge', 'folia'].includes(minecraft.loader)) return res.status(400).json({ error: 'Choose a supported Minecraft server loader.' })
  if (template === 'minecraft' && !['1.21.11', '1.21.10', '1.21.8', '1.21.4', '1.20.6', '1.20.4', '1.20.1'].includes(String(minecraft.version))) return res.status(400).json({ error: 'Choose a supported Minecraft version.' })
  if (template === 'minecraft' && (Number(minecraft.maxPlayers) < 1 || Number(minecraft.maxPlayers) > 200)) return res.status(400).json({ error: 'Player slots must be between 1 and 200.' })
  if (code && !coupon?.active) return res.status(400).json({ error: 'Invalid coupon.' })
  if (coupon && !couponAllowedForUser(coupon.code, req.user.id)) return res.status(400).json({ error: 'Invalid coupon.' })
  if (coupon && !coupon.plans.includes(plan.id)) return res.status(400).json({ error: `${coupon.code} is not valid for this plan.` })
  if (coupon?.firstMonthOnly && couponAlreadyUsed(coupon.code, req.user.id)) return res.status(409).json({ error: `${coupon.code} has already been used for this account's first month.` })
  const discount = coupon ? +(plan.price * coupon.percent / 100).toFixed(2) : 0, total = +(plan.price - discount).toFixed(2)
  const order = { id: crypto.randomUUID(), userId: req.user.id, workspaceId: workspace.id, plan: plan.id, subtotal: plan.price, discount, total, coupon: coupon?.code || null, status: total === 0 ? 'paid' : 'payment_pending', createdAt: new Date().toISOString() }
  const uploadPath = needsProject && source === 'upload' && archiveBytes ? path.join(UPLOAD_DIR, `${order.id}.zip`) : null
  if (uploadPath) fs.writeFileSync(uploadPath, archiveBytes, { mode: 0o600, flag: 'wx' })
  order.pending = { name, template, cpu: plan.cpu, ram: plan.ram, disk: plan.disk, entryFile, archiveName: archiveName.slice(0, 120), uploadPath, github: needsProject && source === 'github' ? { repository, branch: branch || null, webhookSecret: crypto.randomBytes(24).toString('hex') } : null, minecraft: template === 'minecraft' ? { loader: minecraft.loader, version: String(minecraft.version), maxPlayers: Number(minecraft.maxPlayers), motd: clean(minecraft.motd || 'A Vyron Minecraft Server').slice(0, 80) } : null }
  db.orders.push(order)
  try {
    if (total > 0) {
      const checkout = await createStripeCheckout(order, req.user)
      order.paymentProvider = 'stripe'; order.stripeMode = 'test'; order.stripeSessionId = checkout.id
      save()
      recordAudit(req, 'billing.checkout.started', order.id, { provider: 'stripe-test', total: order.total })
      return res.status(202).json({ order: { ...order, pending: undefined }, payment: { provider: 'stripe', mode: 'test', orderId: order.id, sessionId: checkout.id, clientSecret: checkout.client_secret, publishableKey: stripePublishableKey, total: order.total, currency: 'EUR', embedded: true } })
    }
    const vm = await provisionPaidOrder(order)
    recordAudit(req, 'node.create', vm.name, { template: vm.template, plan: vm.plan, cpu: vm.cpu, ram: vm.ram, disk: vm.disk })
    res.status(201).json({ order: { ...order, pending: undefined }, vm: { ...vm, userId: undefined, uploadPath: undefined } })
  } catch (error) { order.status = 'failed'; save(); res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/payments/paypal/capture', requireAuth, async (req, res) => {
  const order = db.orders.find(item => item.id === clean(req.body.orderId) && item.userId === req.user.id)
  if (!order || !order.paypalOrderId) return res.status(404).json({ error: 'PayPal order not found.' })
  if (order.status === 'paid' && order.kind === 'upgrade' && order.upgradeAppliedAt) return res.json({ order: { ...order, pendingUpgrade: undefined }, vm: db.vms.find(vm => vm.id === order.targetVmId) })
  if (order.status === 'paid' && order.vmId) return res.json({ order: { ...order, pending: undefined }, vm: db.vms.find(vm => vm.id === order.vmId) })
  if (clean(req.body.paypalOrderId) !== order.paypalOrderId) return res.status(400).json({ error: 'PayPal order does not match this checkout.' })
  try {
    if (order.status === 'paid') {
      if (order.kind === 'upgrade') {
        const vm = await applyPaidUpgrade(order)
        return res.json({ order: { ...order, pendingUpgrade: undefined }, vm: { ...vm, userId: undefined, uploadPath: undefined } })
      }
      const vm = await provisionPaidOrder(order)
      return res.json({ order: { ...order, pending: undefined }, vm: { ...vm, userId: undefined, uploadPath: undefined } })
    }
    const captured = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(order.paypalOrderId)}/capture`, { method: 'POST', requestId: `vyron-capture-${order.id}`, body: '{}' }, order.paypalMode || 'sandbox')
    const capture = captured.purchase_units?.[0]?.payments?.captures?.[0]
    const amount = Number(capture?.amount?.value)
    if (captured.status !== 'COMPLETED' || capture?.status !== 'COMPLETED' || capture?.amount?.currency_code !== 'EUR' || amount !== Number(order.total)) throw Object.assign(new Error('PayPal did not confirm the expected payment amount.'), { status: 409 })
    order.status = 'paid'; order.paidAt = new Date().toISOString(); order.paypalCaptureId = capture.id
    convertReferral(order.userId)
    if (order.kind === 'upgrade') {
      const vm = await applyPaidUpgrade(order)
      recordAudit(req, 'billing.upgrade.captured', order.id, { provider: 'paypal', total: order.total, node: vm.name, previous: vm.previous, next: { cpu: vm.cpu, ram: vm.ram, disk: vm.disk } })
      return res.json({ order: { ...order, pendingUpgrade: undefined }, vm: { ...vm, userId: undefined, uploadPath: undefined } })
    }
    const vm = await provisionPaidOrder(order)
    recordAudit(req, 'billing.payment.captured', order.id, { provider: 'paypal', total: order.total, node: vm.name })
    res.json({ order: { ...order, pending: undefined }, vm: { ...vm, userId: undefined, uploadPath: undefined } })
  } catch (error) {
    order.paymentError = error.message; save()
    res.status(error.status || 502).json({ error: error.message })
  }
})

const ownedVm = (req, res) => {
  const workspace = activeWorkspace(req.user)
  if (workspace && req.method !== 'GET' && roleRank(workspaceRole(req.user, workspace)) < 2) { res.status(403).json({ error: 'Developer access is required.' }); return null }
  const vm = workspace && db.vms.find(v => v.name === req.params.name && v.workspaceId === workspace.id && v.status !== 'deleted')
  if (!vm) res.status(404).json({ error: 'Node not found.' })
  return vm
}
const ownedMinecraftVm = (req, res) => {
  const vm = ownedVm(req, res)
  if (vm && vm.template !== 'minecraft') { res.status(400).json({ error: 'This is not a Minecraft node.' }); return null }
  return vm
}
app.get('/v1/vms/:name/minecraft/status', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  await syncMinecraft(vm); save()
  const { rconPassword, ...minecraft } = vm.minecraft || {}
  res.json(minecraft)
})
app.get('/v1/vms/:name/minecraft/logs', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  if (vm.status !== 'running' || ['queued', 'installing'].includes(vm.minecraft?.status)) return res.status(409).json({ error: 'Minecraft is still being installed.' })
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/logs?lines=${encodeURIComponent(req.query.lines || 180)}`)) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/minecraft/command', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  if (vm.minecraft?.status !== 'running') return res.status(409).json({ error: 'Wait until the Minecraft server is ready.' })
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/command`, { method: 'POST', body: JSON.stringify({ command: req.body.command, rconPassword: vm.minecraft.rconPassword }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/minecraft/retry', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before retrying Minecraft installation.' })
  if (!['failed', 'stopped'].includes(vm.minecraft?.status)) return res.status(409).json({ error: 'Minecraft installation can only be retried after a failed or stopped setup.' })
  vm.minecraft.status = 'queued'; vm.minecraft.stage = 'Retrying Minecraft installation'; delete vm.minecraft.error; save()
  startMinecraftSetup(vm)
  res.status(202).json({ status: 'installing', stage: vm.minecraft.stage })
})
app.post('/v1/internal/vms/:name/minecraft/retry', requireAdminKey, (req, res) => {
  const vm = db.vms.find(item => item.name === req.params.name && item.template === 'minecraft' && item.status !== 'deleted')
  if (!vm) return res.status(404).json({ error: 'Minecraft node not found.' })
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before retrying Minecraft installation.' })
  vm.minecraft.status = 'queued'; vm.minecraft.stage = 'Retrying Minecraft installation'; delete vm.minecraft.error; save()
  startMinecraftSetup(vm)
  res.status(202).json({ status: 'installing', stage: vm.minecraft.stage })
})
app.post('/v1/vms/:name/minecraft/:action', requireAuth, async (req, res) => {
  const vm = ownedMinecraftVm(req, res); if (!vm) return
  if (!['start', 'stop', 'restart'].includes(req.params.action)) return res.status(400).json({ error: 'Invalid Minecraft action.' })
  if (['start', 'restart'].includes(req.params.action) && !requireStartAvailability(res)) return
  try { const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/${req.params.action}`, { method: 'POST' }); vm.minecraft.status = result.status; vm.minecraft.stage = req.params.action === 'stop' ? 'Server stopped' : `Starting ${vm.minecraft.loader} server`; save(); res.json(result) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/exec', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  const command = String(req.body.command || ''), cwd = String(req.body.cwd || '/root')
  if (!command.trim() || command.length > 2000) return res.status(400).json({ error: 'Command must be 1–2000 characters.' })
  if (!/^\/[\x20-\x7E]{0,299}$/.test(cwd) || cwd.includes('..')) return res.status(400).json({ error: 'Invalid working directory.' })
  if (vm.status !== 'running') return res.status(409).json({ error: 'The node must be running to use the terminal.' })
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/exec`, { method: 'POST', body: JSON.stringify({ command, cwd }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/terminal-ticket', requireAuth, (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'The node must be running to open its KVM console.' })
  const ticket = crypto.randomBytes(32).toString('hex')
  terminalTickets.set(ticket, { vmName: vm.name, userId: req.user.id, expiresAt: Date.now() + 60_000 })
  recordAudit(req, 'node.console.opened', vm.name)
  res.status(201).json({ ticket, expiresIn: 60 })
})
app.put('/v1/vms/:name/runtime-settings', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.template !== 'node') return res.status(400).json({ error: 'Runtime environment settings are available for Node.js nodes.' })
  const environment = req.body.environment && typeof req.body.environment === 'object' && !Array.isArray(req.body.environment) ? req.body.environment : {}
  const entries = Object.entries(environment)
  if (entries.length > 30 || entries.some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 2000 || /[\0\r\n]/.test(value))) return res.status(400).json({ error: 'Use up to 30 uppercase environment variables with safe values.' })
  const autoRestart = req.body.autoRestart !== false
  const hourUtc = Math.max(0, Math.min(23, Number(req.body.schedule?.hourUtc) || 0))
  const schedule = { enabled: Boolean(req.body.schedule?.enabled), hourUtc, action: 'restart_service' }
  try {
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/runtime-settings`, { method: 'PUT', body: JSON.stringify({ environment, autoRestart }) })
    vm.runtime = { autoRestart, environment, schedule, updatedAt: new Date().toISOString() }
    if (result.appPort) {
      const dnsRecord = await ensureNodeHostname(vm)
      vm.deployment = { ...(vm.deployment || {}), status: 'deployed', appPort: result.appPort, port: 80, deployedAt: new Date().toISOString() }
      delete vm.deployment.error
      vm.route = { ...(vm.route || {}), type: 'web', hostname: vm.domain, targetPort: result.appPort, proxyPort: 80, status: 'active', cloudflareDnsId: dnsRecord?.id || vm.route?.cloudflareDnsId || null }
      createNodeEvent(vm, 'deployment_recovered', 'Deployment recovered', `Runtime settings applied and application is live on port ${result.appPort}.`)
    }
    save(); recordAudit(req, 'node.runtime.update', vm.name, { autoRestart, environmentKeys: Object.keys(environment), schedule })
    res.json({ ...result, schedule })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.put('/v1/vms/:name/websites', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.template !== 'node') return res.status(400).json({ error: 'Multiple websites are available for Node.js nodes.' })
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before changing website routes.' })
  const requested = Array.isArray(req.body.websites) ? req.body.websites : []
  if (requested.length > 5) return res.status(400).json({ error: 'A Node.js node supports up to five websites.' })
  const websites = requested.map(item => ({ slot: Number(item.slot), enabled: item.enabled === true, entryFile: clean(item.entryFile).replaceAll('\\', '/').replace(/^\/+/, '') }))
  if (websites.some(item => !Number.isInteger(item.slot) || item.slot < 1 || item.slot > 5 || (item.enabled && (!/^[A-Za-z0-9._/-]{1,240}$/.test(item.entryFile) || item.entryFile.split('/').some(part => !part || part === '..') || !/\.(?:js|mjs|cjs)$/i.test(item.entryFile))))) return res.status(400).json({ error: 'Each enabled website needs a valid .js, .mjs or .cjs start file.' })
  if (new Set(websites.map(item => item.slot)).size !== websites.length) return res.status(400).json({ error: 'Website slots must be unique.' })
  try {
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/websites`, { method: 'PUT', body: JSON.stringify({ websites }) })
    vm.websites = result.websites || []
    vm.websitesUpdatedAt = new Date().toISOString()
    let dnsWarning = null
    if (vm.websites.some(site => site.enabled !== false)) {
      try {
        const dnsRecord = await ensureNodeHostname(vm)
        vm.route = { ...(vm.route || {}), type: 'web', hostname: vm.domain, proxyPort: 80, status: 'active', cloudflareDnsId: dnsRecord?.id || vm.route?.cloudflareDnsId || null }
        delete vm.route.dnsError
      } catch (error) {
        dnsWarning = error.message
        vm.route = { ...(vm.route || {}), type: 'web', hostname: vm.domain, status: 'pending', dnsError: error.message }
      }
    }
    save(); recordAudit(req, 'node.websites.update', vm.name, { websites: vm.websites.map(item => ({ slot: item.slot, path: item.path, entryFile: item.entryFile })) })
    createNodeEvent(vm, 'websites_updated', 'Website routes updated', `${vm.websites.length} of 5 website slots active`)
    res.json({ websites: vm.websites, baseUrl: `https://${vm.customDomains?.find(item => item.status === 'active')?.domain || vm.domain}`, ...(dnsWarning ? { warning: `Website saved, but DNS provisioning will retry automatically: ${dnsWarning}` } : {}) })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/upgrade', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (roleRank(workspaceRole(req.user, activeWorkspace(req.user))) < 3) return res.status(403).json({ error: 'Workspace administrator access is required to upgrade a node.' })
  const cpu = Number(req.body.cpu), ram = Number(req.body.ram), disk = Number(req.body.disk)
  if (![.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].includes(cpu) || cpu < vm.cpu) return res.status(400).json({ error: 'Choose CPU between the current allocation and 4 vCPU.' })
  if (ram < vm.ram || ram > 12 || ram * 2 % 1) return res.status(400).json({ error: 'Choose RAM between the current allocation and 12 GB.' })
  if (disk < vm.disk || disk > 500 || (disk !== vm.disk && disk % 100 !== 0)) return res.status(400).json({ error: 'Choose the current storage size or an upgrade in 100 GB steps up to 500 GB.' })
  if (cpu === vm.cpu && ram === vm.ram && disk === vm.disk) return res.status(400).json({ error: 'Choose at least one resource to upgrade.' })
  const delta = { cpu: +(cpu - vm.cpu).toFixed(1), ram: +(ram - vm.ram).toFixed(1), disk: disk - vm.disk }
  const total = +(delta.cpu * upgradeRates.cpu + delta.ram * upgradeRates.ram + delta.disk / 100 * upgradeRates.diskPer100Gb).toFixed(2)
  try {
    const capacity = await agentRequest('/v1/capacity')
    const missing = Object.keys(delta).filter(key => delta[key] > Number(capacity.available?.[key] || 0))
    if (missing.length) return res.status(409).json({ error: `This upgrade is currently unavailable because server capacity is full (${missing.join(', ')}).`, capacity })
    const order = { id: crypto.randomUUID(), kind: 'upgrade', userId: req.user.id, workspaceId: vm.workspaceId, targetVmId: vm.id, nodeName: vm.name, plan: 'Resource upgrade', subtotal: total, discount: 0, total, coupon: null, status: 'payment_pending', pendingUpgrade: { cpu, ram, disk }, rates: upgradeRates, createdAt: new Date().toISOString() }
    const checkout = await createStripeCheckout(order, req.user)
    order.paymentProvider = 'stripe'; order.stripeMode = 'test'; order.stripeSessionId = checkout.id
    db.orders.push(order); save()
    recordAudit(req, 'billing.upgrade.started', vm.name, { total, previous: { cpu: vm.cpu, ram: vm.ram, disk: vm.disk }, next: { cpu, ram, disk } })
    res.status(202).json({ order: { ...order, pendingUpgrade: undefined }, payment: { provider: 'stripe', mode: 'test', orderId: order.id, sessionId: checkout.id, clientSecret: checkout.client_secret, publishableKey: stripePublishableKey, total: order.total, currency: 'EUR', embedded: true } })
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/v1/vms/:name/files', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node to browse its files.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files?path=${encodeURIComponent(String(req.query.path || '.'))}&scope=${scope}`)) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/v1/vms/:name/file', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'A running node is required.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/file?path=${encodeURIComponent(String(req.query.path || ''))}&scope=${scope}`)) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.put('/v1/vms/:name/file', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'A running node is required.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/file`, { method: 'PUT', body: JSON.stringify({ path: req.body.path, content: req.body.content, scope }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.delete('/v1/vms/:name/file', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'A running node is required.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/file`, { method: 'DELETE', body: JSON.stringify({ path: req.body.path, scope }) }); recordAudit(req, 'node.file.delete', vm.name, { path: clean(req.body.path).slice(0, 240) }); res.json(result) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/files/folder', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before creating folders.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { res.status(201).json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/folder`, { method: 'POST', body: JSON.stringify({ path: req.body.path, scope }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/files/upload/start', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before uploading files.' })
  const size = Number(req.body.size)
  if (!Number.isSafeInteger(size) || size < 0 || size > 1024 ** 3) return res.status(413).json({ error: 'Files are limited to 1 GB.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { res.status(201).json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/upload/start`, { method: 'POST', body: JSON.stringify({ path: req.body.path, size, uploadId: req.body.uploadId, scope }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/files/upload/chunk', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before uploading files.' })
  const data = String(req.body.data || '')
  if (!data || data.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'Upload chunk is too large.' })
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/upload/chunk`, { method: 'POST', body: JSON.stringify({ uploadId: req.body.uploadId, offset: req.body.offset, data }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/files/upload/complete', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before uploading files.' })
  try { res.status(201).json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/upload/complete`, { method: 'POST', body: JSON.stringify({ uploadId: req.body.uploadId }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.delete('/v1/vms/:name/files/upload/:uploadId', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  try { res.json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/upload/${encodeURIComponent(req.params.uploadId)}`, { method: 'DELETE' })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/files/upload', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before uploading files.' })
  const data = String(req.body.data || '')
  if (!data || data.length > 14 * 1024 * 1024) return res.status(413).json({ error: 'Files are limited to 10 MB.' })
  const scope = ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  try { res.status(201).json(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/upload`, { method: 'POST', body: JSON.stringify({ path: req.body.path, data, scope }) })) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.post('/v1/vms/:name/redeploy', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (!vm.github?.repository) return res.status(409).json({ error: 'This node is not linked to GitHub.' })
  if (vm.status !== 'running') return res.status(409).json({ error: 'Start the node before redeploying.' })
  vm.deployment = { ...vm.deployment, status: 'queued', requestedAt: new Date().toISOString() }
  save(); startNodeDeployment(vm); res.status(202).json({ deployment: vm.deployment })
})
app.patch('/v1/vms/:name/github', requireAuth, (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (!vm.github?.repository) return res.status(409).json({ error: 'This node is not linked to GitHub.' })
  vm.github.autoDeploy = req.body.autoDeploy !== false
  save(); recordAudit(req, 'deployment.github.settings', vm.name, { autoDeploy: vm.github.autoDeploy })
  createNodeEvent(vm, 'github_settings', `GitHub auto-deploy ${vm.github.autoDeploy ? 'enabled' : 'disabled'}`, vm.github.repository)
  res.json({ repository: vm.github.repository, branch: vm.github.branch || null, autoDeploy: vm.github.autoDeploy })
})
app.post('/v1/vms/:name/:action', requireAuth, async (req, res) => {
  if (!['start', 'stop'].includes(req.params.action)) return res.status(400).json({ error: 'Invalid action.' })
  const vm = ownedVm(req, res); if (!vm) return
  if (req.params.action === 'start' && !requireStartAvailability(res)) return
  try { const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/${req.params.action}`, { method: 'POST' }); vm.status = result.status; vm.desiredState = req.params.action === 'start' ? 'running' : 'stopped'; save(); recordAudit(req, `node.${req.params.action}`, vm.name); createNodeEvent(vm, `node_${req.params.action}`, `Node ${req.params.action === 'start' ? 'started' : 'stopped'}`, `Requested by ${req.user.email}`); res.json(result) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.delete('/v1/vms/:name', requireAuth, async (req, res) => {
  const vm = ownedVm(req, res); if (!vm) return
  if (roleRank(workspaceRole(req.user, activeWorkspace(req.user))) < 3) return res.status(403).json({ error: 'Workspace administrator access is required to delete a node.' })
  if (clean(req.body.confirmation) !== `DELETE ${vm.name}`) return res.status(400).json({ error: `Type DELETE ${vm.name} to confirm deletion.` })
  try { const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}`, { method: 'DELETE' }); createNodeEvent(vm, 'node_deleted', 'Node deleted', `Permanently deleted by ${req.user.email}`, 'warning'); db.domains = db.domains.filter(domain => domain.vmId !== vm.id); vm.status = 'deleted'; vm.deletedAt = new Date().toISOString(); save(); recordAudit(req, 'node.delete', vm.name); res.json(result) }
  catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

app.get('/v1/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  const nodes = db.vms.filter(vm => vm.status !== 'deleted')
  await syncVmStates(nodes)
  let host = { status: 'offline', host: 'vyron-servers', metrics: {} }
  try { host = await agentRequest('/health') } catch {}
  const paidOrders = db.orders.filter(order => order.status === 'paid')
  const users = db.users.map(user => {
    const userNodes = nodes.filter(vm => vm.userId === user.id)
    const spend = paidOrders.filter(order => order.userId === user.id).reduce((sum, order) => sum + Number(order.total || 0), 0)
    return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, isAdmin: isAdmin(user), approvalStatus: approvalStatus(user), approvedAt: user.approvedAt || null, approvalRejectedAt: user.approvalRejectedAt || null, banned: Boolean(user.bannedAt), bannedAt: user.bannedAt || null, banReason: user.banReason || null, free26Enabled: couponAllowedForUser('FREE26', user.id), workspaces: userWorkspaces(user).length, nodes: userNodes.length, spend: +spend.toFixed(2) }
  })
  const allocated = nodes.filter(vm => !['failed'].includes(vm.status)).reduce((total, vm) => ({ cpu: total.cpu + Number(vm.cpu || 0), ram: total.ram + Number(vm.ram || 0), disk: total.disk + Number(vm.disk || 0) }), { cpu: 0, ram: 0, disk: 0 })
  res.json({
    generatedAt: new Date().toISOString(),
    host: { ...host, host: 'vyron-servers' },
    stats: { accounts: db.users.length, workspaces: db.workspaces.length, nodes: nodes.length, runningNodes: nodes.filter(vm => vm.status === 'running').length, orders: db.orders.length, revenue: +paidOrders.reduce((sum, order) => sum + Number(order.total || 0), 0).toFixed(2), allocated },
    users: users.sort((a, b) => Number(b.approvalStatus === 'pending') - Number(a.approvalStatus === 'pending') || new Date(b.createdAt) - new Date(a.createdAt)),
    nodes: nodes.map(vm => { const owner = db.users.find(user => user.id === vm.userId); return { id: vm.id, name: vm.name, domain: vm.domain, status: vm.status, template: vm.template, plan: vm.plan, cpu: vm.cpu, ram: vm.ram, disk: vm.disk, createdAt: vm.createdAt, owner: owner ? { name: owner.name, email: owner.email } : null } }),
    orders: db.orders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20).map(({ userId, ...order }) => ({ ...order, customer: db.users.find(user => user.id === userId)?.email || 'Unknown' })),
    auditLogs: (db.auditLogs || []).slice(-50).reverse(),
    supportTickets: (db.supportTickets || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100),
    abuseReports: (db.abuseReports || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100),
    notifications: (db.adminNotifications || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100),
    availability: creationAvailability()
  })
})

app.get('/v1/admin/status-config', requireAuth, requireAdmin, (req, res) => {
  res.json(db.statusConfig?.locations?.length ? db.statusConfig : defaultStatusConfig())
})

app.put('/v1/admin/status-config', requireAuth, requireAdmin, (req, res) => {
  try {
    const requested = Array.isArray(req.body.locations) ? req.body.locations : []
    if (!requested.length || requested.length > 24) return res.status(400).json({ error: 'At least one server location is required.' })
    const allowedStates = new Set(['operational', 'maintenance', 'major'])
    const previousLocations = db.statusConfig?.locations?.length ? db.statusConfig.locations : defaultStatusConfig().locations
    const locations = requested.map((item, index) => {
      const previous = previousLocations.find(location => location.id === item.id) || previousLocations[index]
      const id = clean(item.id || previous?.id).slice(0, 60)
      const x = Number(item.x), y = Number(item.y), status = clean(item.status).toLowerCase()
      if (!id || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100 || !allowedStates.has(status)) throw Object.assign(new Error('Invalid server location configuration.'), { status: 400 })
      return { id, name: clean(item.name || previous?.name || `Server ${index + 1}`).slice(0, 80), country: clean(item.country || previous?.country).slice(0, 80), city: clean(item.city || previous?.city).slice(0, 80), region: clean(item.region || previous?.region).slice(0, 80), x: +x.toFixed(3), y: +y.toFixed(3), status }
    })
    const now = new Date().toISOString()
    db.statusIncidents ||= []
    for (const location of locations) {
      const previous = previousLocations.find(item => item.id === location.id)
      if (!previous || previous.status === location.status) continue
      for (const incident of db.statusIncidents.filter(item => item.locationId === location.id && !item.resolvedAt)) incident.resolvedAt = now
      if (location.status !== 'operational') db.statusIncidents.push({ id: crypto.randomUUID(), locationId: location.id, state: location.status === 'major' ? 'major' : 'minor', title: location.status === 'major' ? `Major incident at ${location.name}` : `Maintenance at ${location.name}`, detail: location.status === 'major' ? `${location.name} is experiencing a major service incident.` : `Scheduled maintenance is in progress at ${location.name}.`, startedAt: now, resolvedAt: null })
      for (const vm of db.vms.filter(item => item.locationId === location.id && item.status !== 'deleted')) createNodeEvent(vm, `location_${location.status}`, location.status === 'operational' ? `${location.name} is operational` : location.status === 'major' ? `Major incident at ${location.name}` : `Maintenance at ${location.name}`, location.status === 'operational' ? 'Normal service has been restored.' : location.status === 'major' ? 'Your node may be affected. Updates will appear on the status page.' : 'Scheduled maintenance is in progress.', location.status === 'major' ? 'critical' : location.status === 'maintenance' ? 'warning' : 'info')
    }
    db.statusConfig = { locations, updatedAt: now, updatedBy: req.user.id }
    save()
    recordAudit(req, 'status.configuration.update', 'public-status', { locations: locations.map(({ id, x, y, status }) => ({ id, x, y, status })) })
    res.json(db.statusConfig)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.put('/v1/admin/coupons/FREE26/users/:id', requireAuth, requireAdmin, (req, res) => {
  const user = db.users.find(item => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'Account not found.' })
  db.couponGrants ||= []
  db.couponGrants = db.couponGrants.filter(item => !(item.code === 'FREE26' && item.userId === user.id))
  if (req.body.enabled === true) db.couponGrants.push({ code: 'FREE26', userId: user.id, enabled: true, updatedAt: new Date().toISOString(), updatedBy: req.user.id })
  save(); recordAudit(req, req.body.enabled === true ? 'coupon.access.grant' : 'coupon.access.revoke', user.email, { coupon: 'FREE26' })
  res.json({ userId: user.id, code: 'FREE26', enabled: couponAllowedForUser('FREE26', user.id) })
})

app.patch('/v1/admin/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const report = (db.abuseReports || []).find(item => item.id === req.params.id)
  if (!report) return res.status(404).json({ error: 'Report not found.' })
  const status = clean(req.body.status).toLowerCase()
  if (!['pending', 'reviewing', 'resolved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid report status.' })
  report.status = status; report.updatedAt = new Date().toISOString(); report.updatedBy = req.user.id
  save(); recordAudit(req, 'abuse.report.update', report.domain, { reportId: report.id, status })
  res.json({ report })
})

app.patch('/v1/admin/notifications/:id/read', requireAuth, requireAdmin, (req, res) => {
  const notification = (db.adminNotifications || []).find(item => item.id === req.params.id)
  if (!notification) return res.status(404).json({ error: 'Notification not found.' })
  notification.readAt = req.body.read === false ? null : new Date().toISOString(); save(); res.json({ notification })
})

app.patch('/v1/admin/support/tickets/:id', requireAuth, requireAdmin, (req, res) => {
  const ticket = (db.supportTickets || []).find(item => item.id === req.params.id)
  if (!ticket) return res.status(404).json({ error: 'Support ticket not found.' })
  const status = clean(req.body.status || ticket.status).toLowerCase(), priority = clean(req.body.priority || ticket.priority).toLowerCase(), reply = clean(req.body.reply).slice(0, 4000)
  if (!['open', 'waiting', 'resolved', 'closed'].includes(status) || !['low', 'normal', 'high', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Invalid ticket status or priority.' })
  ticket.status = status; ticket.priority = priority; ticket.updatedAt = new Date().toISOString()
  if (reply) { ticket.messages ||= []; ticket.messages.push({ id: crypto.randomUUID(), authorId: req.user.id, author: 'Vyron Support', message: reply, createdAt: ticket.updatedAt, staff: true }) }
  save(); recordAudit(req, 'support.ticket.update', ticket.id, { status, priority, replied: Boolean(reply) })
  res.json({ ticket })
})

app.get('/v1/admin/alert-config', requireAuth, requireAdmin, (req, res) => {
  const config = readAlertConfig()
  res.json({ provider: 'resend', configured: Boolean(config.apiKey && config.recipient && config.from), recipient: config.recipient || '', from: config.from || '', trafficThresholdMbps: Number(config.trafficThresholdMbps || 500), trafficWindowSamples: Number(config.trafficWindowSamples || 2), cooldownMinutes: Number(config.cooldownMinutes || 30), keyHint: config.apiKey ? `${config.apiKey.slice(0, 4)}••••${config.apiKey.slice(-4)}` : '' })
})

app.put('/v1/admin/alert-config', requireAuth, requireAdmin, (req, res) => {
  const previous = readAlertConfig(), apiKey = clean(req.body.apiKey) || previous.apiKey, recipient = clean(req.body.recipient).toLowerCase(), from = clean(req.body.from), trafficThresholdMbps = Number(req.body.trafficThresholdMbps), trafficWindowSamples = Number(req.body.trafficWindowSamples || 2), cooldownMinutes = Number(req.body.cooldownMinutes || 30)
  if (!/^re_[A-Za-z0-9_-]{8,}$/.test(apiKey || '')) return res.status(400).json({ error: 'Enter a valid Resend API key.' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return res.status(400).json({ error: 'Enter a valid alert recipient.' })
  if (!from || !/<[^\s@]+@[^\s@]+\.[^\s@]+>$/.test(from)) return res.status(400).json({ error: 'Use a sender such as Vyron Security <security@vyronhosting.com>.' })
  if (!Number.isFinite(trafficThresholdMbps) || trafficThresholdMbps < 25 || trafficThresholdMbps > 10000) return res.status(400).json({ error: 'Traffic threshold must be between 25 and 10000 Mbps.' })
  if (![2, 3, 4, 5].includes(trafficWindowSamples)) return res.status(400).json({ error: 'Traffic window must be 2–5 samples.' })
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 5 || cooldownMinutes > 1440) return res.status(400).json({ error: 'Cooldown must be between 5 and 1440 minutes.' })
  saveAlertConfig({ provider: 'resend', apiKey, recipient, from, trafficThresholdMbps, trafficWindowSamples, cooldownMinutes, updatedAt: new Date().toISOString(), updatedBy: req.user.id })
  recordAudit(req, 'alerts.configuration.update', 'security-alerts', { recipient, trafficThresholdMbps, trafficWindowSamples, cooldownMinutes })
  res.json({ provider: 'resend', recipient, from, trafficThresholdMbps, trafficWindowSamples, cooldownMinutes, configured: true, keyHint: `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}` })
})

const publicPaypalConfig = () => {
  const sandbox = paypalCredentials('sandbox'), live = paypalCredentials('live')
  return { mode: paypalMode(), sandboxConfigured: Boolean(sandbox.id && sandbox.secret), liveConfigured: Boolean(live.id && live.secret), credentialsEditable: false }
}
const publicStripeConfig = () => ({ mode: 'test', configured: stripeTestConfigured(), webhookConfigured: stripeWebhookSecret.startsWith('whsec_'), publishableKeyHint: stripePublishableKey ? `${stripePublishableKey.slice(0, 12)}…${stripePublishableKey.slice(-4)}` : '' })
app.get('/v1/admin/stripe-config', requireAuth, requireAdmin, (_, res) => res.json(publicStripeConfig()))
app.get('/v1/admin/paypal-config', requireAuth, requireAdmin, (_, res) => res.json(publicPaypalConfig()))
app.put('/v1/admin/paypal-config', requireAuth, requireAdmin, (req, res) => {
  const mode = clean(req.body.mode).toLowerCase()
  if (!['sandbox', 'live'].includes(mode)) return res.status(400).json({ error: 'Choose sandbox or live mode.' })
  const credentials = paypalCredentials(mode)
  if (!credentials.id || !credentials.secret) return res.status(409).json({ error: `Add the protected PayPal ${mode} credentials on the server before enabling this mode.` })
  const temporary = `${PAYPAL_CONFIG_FILE}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ mode, updatedAt: new Date().toISOString(), updatedBy: req.user.id }, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, PAYPAL_CONFIG_FILE)
  recordAudit(req, 'billing.paypal_mode.update', 'paypal', { mode })
  res.json(publicPaypalConfig())
})

app.get('/v1/admin/ai-config', requireAuth, requireAdmin, (req, res) => {
  const config = readAiConfig()
  res.json({ provider: config.provider || 'openrouter', configured: Boolean(config.endpoint && config.apiKey), endpoint: config.endpoint || DEFAULT_AI_CONFIG.endpoint, model: config.model || DEFAULT_AI_CONFIG.model, webSearch: config.webSearch !== false, keyHint: config.apiKey ? `${config.apiKey.slice(0, 5)}••••${config.apiKey.slice(-4)}` : '' })
})
app.put('/v1/admin/ai-config', requireAuth, requireAdmin, (req, res) => {
  const payload = req.body || {}, previous = readAiConfig(), provider = 'openrouter', endpoint = DEFAULT_AI_CONFIG.endpoint, model = clean(payload.model || DEFAULT_AI_CONFIG.model).slice(0, 100), apiKey = clean(payload.apiKey) || previous.apiKey, webSearch = payload.webSearch !== false
  if (!apiKey || !/^sk-or-/.test(apiKey)) return res.status(400).json({ error: 'Enter a valid OpenRouter API key.' })
  if (!/^[A-Za-z0-9._:/-]{2,100}$/.test(model)) return res.status(400).json({ error: 'Invalid model identifier.' })
  saveAiConfig({ provider, endpoint, model, apiKey, webSearch, updatedAt: new Date().toISOString(), updatedBy: req.user.id })
  res.json({ provider, configured: true, endpoint, model, webSearch, keyHint: `${apiKey.slice(0, 5)}••••${apiKey.slice(-4)}` })
})

app.delete('/v1/admin/nodes/:id', requireAuth, requireAdmin, async (req, res) => {
  const index = db.vms.findIndex(vm => vm.id === req.params.id && vm.status !== 'deleted')
  if (index === -1) return res.status(404).json({ error: 'Node not found.' })
  const vm = db.vms[index]
  if (clean(req.body?.confirmation) !== `DELETE ${vm.name}`) return res.status(400).json({ error: `Type DELETE ${vm.name} to confirm deletion.` })
  let hypervisorRemoved = false
  try {
    await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}`, { method: 'DELETE' })
    hypervisorRemoved = true
  } catch (error) {
    if (!/not found|no domain with matching name/i.test(error.message)) return res.status(error.status || 502).json({ error: error.message })
  }
  if (vm.uploadPath) fs.rmSync(vm.uploadPath, { force: true })
  db.vms.splice(index, 1)
  save()
  recordAudit(req, 'admin.node.delete', vm.name, { hypervisorRemoved })
  res.json({ deleted: true, id: vm.id, name: vm.name, hypervisorRemoved, databaseRecordRemoved: true })
})

app.patch('/v1/admin/users/:id/ban', requireAuth, requireAdmin, (req, res) => {
  const user = db.users.find(item => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'Account not found.' })
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' })
  if (isAdmin(user)) return res.status(403).json({ error: 'Administrator accounts cannot be suspended.' })
  const banned = req.body.banned !== false
  if (banned) {
    user.bannedAt = new Date().toISOString()
    user.bannedBy = req.user.id
    user.banReason = clean(req.body.reason).slice(0, 240) || 'Suspended by an administrator'
    db.sessions = db.sessions.filter(session => session.userId !== user.id)
  } else {
    delete user.bannedAt
    delete user.bannedBy
    delete user.banReason
  }
  save()
  recordAudit(req, banned ? 'account.suspend' : 'account.restore', user.email, { reason: user.banReason || null })
  res.json({ user: { id: user.id, banned: Boolean(user.bannedAt), bannedAt: user.bannedAt || null, banReason: user.banReason || null } })
})

app.patch('/v1/admin/users/:id/approval', requireAuth, requireAdmin, (req, res) => {
  const user = db.users.find(item => item.id === req.params.id)
  if (!user) return res.status(404).json({ error: 'Account not found.' })
  if (user.id === req.user.id || isAdmin(user)) return res.status(403).json({ error: 'Administrator approval cannot be changed.' })
  const status = clean(req.body.status).toLowerCase()
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose approved or rejected.' })
  if (status === 'approved') {
    user.approvedAt = new Date().toISOString()
    user.approvedBy = req.user.id
    delete user.approvalRejectedAt
    delete user.approvalRejectedBy
  } else {
    delete user.approvedAt
    delete user.approvedBy
    user.approvalRejectedAt = new Date().toISOString()
    user.approvalRejectedBy = req.user.id
    db.sessions = db.sessions.filter(session => session.userId !== user.id)
  }
  save()
  recordAudit(req, status === 'approved' ? 'account.approve' : 'account.reject', user.email)
  const event = { title: status === 'approved' ? 'Your Vyron account was approved' : 'Your Vyron account request was not approved', detail: status === 'approved' ? 'You can now sign in and use Vyron Hosting.' : 'Access to Vyron Hosting was not enabled. Contact Vyron support if you think this is a mistake.' }
  void sendCustomerEmail(user, event)
  res.json({ user: { id: user.id, approvalStatus: status, approvedAt: user.approvedAt || null, approvalRejectedAt: user.approvalRejectedAt || null } })
})

app.post('/v1/admin/terminal', requireAuth, requireAdmin, async (req, res) => {
  const command = safeAdminCommand(req.body.command)
  if (!command) return res.status(400).json({ error: 'Enter a command.' })
  try { const result = await agentRequest('/v1/host/exec', { method: 'POST', body: JSON.stringify({ command }) }); recordAudit(req, 'admin.diagnostic', 'platform', { command }); res.json(result) }
  catch (error) { res.status(error.status || 502).json({ error: error.message, ...(error.body || {}) }) }
})

// Server-only maintenance endpoints.
app.post('/v1/deployments', requireAdminKey, async (req, res) => {
  try { res.status(202).json(await agentRequest('/v1/vms', { method: 'POST', body: JSON.stringify(req.body) })) } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/v1/jobs/:id', requireAdminKey, async (req, res) => {
  try { res.json(await agentRequest(`/v1/jobs/${encodeURIComponent(req.params.id)}`)) } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

const scheduledRuntime = new Map()
const runScheduledNodeTasks = async () => {
  const now = new Date()
  const dayKey = `${now.toISOString().slice(0, 10)}:${now.getUTCHours()}`
  for (const vm of db.vms.filter(item => item.status === 'running' && item.template === 'node' && item.runtime?.schedule?.enabled && Number(item.runtime.schedule.hourUtc) === now.getUTCHours())) {
    if (scheduledRuntime.get(vm.id) === dayKey) continue
    scheduledRuntime.set(vm.id, dayKey)
    try {
      const command = Buffer.from('systemctl restart vyron-node').toString('base64')
      await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/exec`, { method: 'POST', body: JSON.stringify({ command: `echo ${command} | base64 -d | bash`, cwd: '/root' }) })
      vm.runtime.lastScheduledRun = now.toISOString(); save()
    } catch (error) { vm.runtime.lastScheduledError = error.message; save() }
  }
}
const runtimeTimer = setInterval(() => void runScheduledNodeTasks(), 60_000)
runtimeTimer.unref()

const samplePlatformTraffic = async () => {
  try {
    const host = await agentRequest('/health'), totalGb = Number(host.metrics?.networkGb)
    if (!Number.isFinite(totalGb)) return
    db.trafficSamples ||= []
    const now = new Date(), previous = db.trafficSamples.at(-1)
    let mbps = null
    if (previous && totalGb >= Number(previous.totalGb)) {
      const elapsedSeconds = Math.max(1, (now.getTime() - new Date(previous.at).getTime()) / 1000)
      mbps = +((totalGb - Number(previous.totalGb)) * 8000 / elapsedSeconds).toFixed(2)
    }
    db.trafficSamples.push({ at: now.toISOString(), totalGb, mbps })
    db.trafficSamples = db.trafficSamples.slice(-360)
    const config = readAlertConfig(), windowSize = Number(config.trafficWindowSamples || 2), threshold = Number(config.trafficThresholdMbps || 500)
    const recent = db.trafficSamples.slice(-windowSize)
    const sustained = recent.length === windowSize && recent.every(sample => Number(sample.mbps) >= threshold)
    const lastAlert = (db.adminNotifications || []).filter(item => item.kind === 'traffic_alert').at(-1)
    const cooledDown = !lastAlert || now.getTime() - new Date(lastAlert.createdAt).getTime() >= Number(config.cooldownMinutes || 30) * 60_000
    save()
    if (sustained && cooledDown) {
      const average = +(recent.reduce((sum, sample) => sum + Number(sample.mbps || 0), 0) / recent.length).toFixed(1)
      createAdminNotification('traffic_alert', `High network traffic detected (${average} Mbps)`, `Aggregate server traffic stayed above the ${threshold} Mbps security threshold for ${windowSize} consecutive samples. Review active nodes and traffic immediately.`, { averageMbps: average, thresholdMbps: threshold, samples: recent })
    }
  } catch (error) { console.error(`Traffic monitor failed: ${error.message}`) }
}
const trafficTimer = setInterval(() => void samplePlatformTraffic(), 60_000)
trafficTimer.unref()
setTimeout(() => void samplePlatformTraffic(), 5000).unref()

const apiServer = http.createServer(app)
const terminalSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
apiServer.on('upgrade', (req, socket, head) => {
  let parsed
  try { parsed = new URL(req.url, 'http://api.local') } catch { socket.destroy(); return }
  const match = parsed.pathname.match(/^\/v1\/vms\/([a-z][a-z0-9-]{2,31})\/terminal$/)
  const ticketValue = parsed.searchParams.get('ticket') || ''
  const ticket = terminalTickets.get(ticketValue)
  terminalTickets.delete(ticketValue)
  if (!match || !ticket || ticket.expiresAt < Date.now() || ticket.vmName !== match[1]) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
  const user = db.users.find(item => item.id === ticket.userId)
  const workspace = user && activeWorkspace(user)
  const vm = workspace && db.vms.find(item => item.name === match[1] && item.workspaceId === workspace.id && item.status === 'running')
  if (!vm || roleRank(workspaceRole(user, workspace)) < 2) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
  terminalSockets.handleUpgrade(req, socket, head, ws => terminalSockets.emit('connection', ws, req, vm))
})
terminalSockets.on('connection', (client, _req, vm) => {
  const upstream = new WebSocket(`ws://127.0.0.1:8790/v1/vms/${encodeURIComponent(vm.name)}/terminal`, { headers: { Authorization: `Bearer ${agentToken}` }, maxPayload: 64 * 1024 })
  const pending = []
  const closeBoth = () => { if (client.readyState === WebSocket.OPEN) client.close(); if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close() }
  upstream.on('open', () => {
    if (vm.initialPassword) upstream.send(JSON.stringify({ type: 'autologin', username: vm.username || 'vyron', password: vm.initialPassword }))
    for (const [data, binary] of pending.splice(0)) upstream.send(data, { binary })
  })
  upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }) })
  client.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 20) pending.push([data, binary]) })
  upstream.once('error', () => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'error', message: 'The host console is unavailable.' })) })
  upstream.once('close', closeBoth); client.once('close', closeBoth); client.once('error', closeBoth)
})
setInterval(() => { const now = Date.now(); for (const [ticket, value] of terminalTickets) if (value.expiresAt < now) terminalTickets.delete(ticket) }, 60_000).unref()

apiServer.listen(process.env.PORT || 8787, '127.0.0.1', () => {
  console.log('Vyron API listening on 127.0.0.1:8787')
  if (cloudflareConfigured() && process.env.CLOUDFLARE_AUTO_SYNC !== 'false') {
    const timer = setTimeout(() => {
      void ensureCloudflarePrivateRoute()
        .then(({ created }) => console.log(`Cloudflare private route ${privateNetwork} ${created ? 'created' : 'verified'}`))
        .catch(error => console.error(`Cloudflare private route sync failed: ${error.message}`))
    }, 1500)
    timer.unref()
  }
})
