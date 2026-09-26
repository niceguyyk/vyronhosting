const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const dns = require('node:dns')
const { spawn } = require('node:child_process')

dns.setDefaultResultOrder('ipv4first')

const port = Number(process.env.PORT || 25580)
const root = process.env.MINECRAFT_ROOT || '/srv/minecraft'
const dataFile = path.join(root, 'server.json')
const jarFile = path.join(root, 'server.jar')
const javaFor = version => /^1\.20\.[1-4]$/.test(String(version || '')) && fs.existsSync('/usr/lib/jvm/java-17-openjdk-amd64/bin/java') ? '/usr/lib/jvm/java-17-openjdk-amd64/bin/java' : '/usr/bin/java'
const logs = []
const players = new Set()
let child = null
let server = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : null
const save = () => { if (!server) return; fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(dataFile, JSON.stringify(server, null, 2), { mode: 0o600 }) }
const line = value => { const text = String(value || '').trimEnd(); if (!text) return; logs.push({ at: new Date().toISOString(), text }); if (logs.length > 500) logs.splice(0, logs.length - 500); const joined = text.match(/:\s+([A-Za-z0-9_]{3,16}) joined the game/); const left = text.match(/:\s+([A-Za-z0-9_]{3,16}) left the game/); if (joined) players.add(joined[1]); if (left) players.delete(left[1]); if (/Done \([\d.]+s\)!/i.test(text) && server) { server.status = 'running'; server.playersOnline = players.size; save() } }
const body = req => new Promise((resolve, reject) => { const chunks = []; let size = 0; req.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(chunk) }); req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}) } catch { reject(new Error('Invalid JSON')) } }); req.on('error', reject) })
const json = (res, status, value) => { const payload = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }); res.end(payload) }
const fillUrl = async (project, version) => { const response = await fetch(`https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(version)}/builds`, { headers: { 'user-agent': 'VyronHosting/1.0 (https://vyronhosting.com)' } }); if (!response.ok) throw new Error(`${project} API returned ${response.status}`); const builds = await response.json(); const candidates = builds.filter(item => item.channel === 'STABLE' && item.downloads?.['server:default']?.url).sort((a, b) => Number(b.id) - Number(a.id)); if (!candidates[0]) throw new Error(`No stable ${project} build for ${version}`); return candidates[0].downloads['server:default'].url }
const runProcess = (command, args, options = {}) => new Promise((resolve, reject) => {
  const process = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
  process.stdout.on('data', chunk => chunk.toString().split(/\r?\n/).forEach(line))
  process.stderr.on('data', chunk => chunk.toString().split(/\r?\n/).forEach(line))
  process.on('error', reject)
  process.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with code ${code}`)))
})
const forgeBuild = async version => {
  const response = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', { headers: { 'user-agent': 'VyronHosting/1.0 (https://vyronhosting.com)' } })
  if (!response.ok) throw new Error(`Forge version service returned ${response.status}`)
  const promotions = (await response.json()).promos || {}
  const build = promotions[`${version}-recommended`] || promotions[`${version}-latest`]
  if (!build) throw new Error(`Forge does not provide a server build for Minecraft ${version}`)
  return `${version}-${build}`
}
const installForge = async version => {
  const coordinate = await forgeBuild(version)
  const installer = path.join(root, `forge-${coordinate}-installer.jar`)
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(coordinate)}/forge-${encodeURIComponent(coordinate)}-installer.jar`
  line(`Downloading Forge ${coordinate} installer…`)
  const response = await fetch(url, { headers: { 'user-agent': 'VyronHosting/1.0 (https://vyronhosting.com)' } })
  if (!response.ok) throw new Error(`Forge installer download returned ${response.status}`)
  fs.writeFileSync(`${installer}.tmp`, Buffer.from(await response.arrayBuffer()))
  fs.renameSync(`${installer}.tmp`, installer)
  line('Installing Forge server libraries…')
  try { await runProcess(javaFor(version), ['-jar', installer, '--installServer']) } finally { fs.rmSync(installer, { force: true }) }
  if (!fs.existsSync(path.join(root, 'run.sh'))) throw new Error('Forge installer did not create run.sh')
  server.forgeVersion = coordinate
  save()
  line(`Forge ${coordinate} installation complete.`)
}
const resolveJar = async (loader, version) => {
  if (loader === 'paper' || loader === 'folia') return fillUrl(loader, version)
  if (loader === 'purpur') { const response = await fetch(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`); if (!response.ok) throw new Error(`Purpur does not provide ${version}`); const payload = await response.json(), builds = payload.builds?.all || []; const latest = builds.at(-1); if (!latest) throw new Error(`No Purpur build for ${version}`); return `https://api.purpurmc.org/v2/purpur/${version}/${latest}/download` }
  if (loader === 'fabric') {
    const [loaderResponse, installerResponse] = await Promise.all([
      fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`),
      fetch('https://meta.fabricmc.net/v2/versions/installer')
    ])
    if (!loaderResponse.ok) throw new Error(`Fabric does not provide Minecraft ${version}`)
    if (!installerResponse.ok) throw new Error('Fabric installer metadata is unavailable')
    const loaders = await loaderResponse.json(), installers = await installerResponse.json()
    const selectedLoader = loaders.find(item => item.loader?.stable && item.loader?.version)?.loader || loaders.find(item => item.loader?.version)?.loader
    const selectedInstaller = installers.find(item => item.stable && item.version) || installers.find(item => item.version)
    if (!selectedLoader?.version) throw new Error(`No Fabric loader build for Minecraft ${version}`)
    if (!selectedInstaller?.version) throw new Error('No Fabric installer build is available')
    return `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(selectedLoader.version)}/${encodeURIComponent(selectedInstaller.version)}/server/jar`
  }
  if (loader === 'vanilla') { const manifestResponse = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'); if (!manifestResponse.ok) throw new Error('Mojang version API is unavailable'); const manifest = await manifestResponse.json(), selected = manifest.versions?.find(item => item.id === version); if (!selected) throw new Error(`Vanilla does not provide ${version}`); const metaResponse = await fetch(selected.url), meta = await metaResponse.json(); if (!meta.downloads?.server?.url) throw new Error(`No Vanilla server jar for ${version}`); return meta.downloads.server.url }
  throw new Error(`Unsupported loader: ${loader}`)
}
const provision = async () => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'eula.txt'), 'eula=true\n'); const properties = [`server-port=${server.port}`, `query.port=${server.port}`, 'enable-query=true', 'online-mode=true', `max-players=${server.maxPlayers}`, `motd=${server.motd}`, 'view-distance=10', 'simulation-distance=8'].join('\n') + '\n'; fs.writeFileSync(path.join(root, 'server.properties'), properties); if (server.loader === 'forge') { if (!fs.existsSync(path.join(root, 'run.sh'))) { server.status = 'provisioning'; save(); await installForge(server.mcVersion) } return } if (!fs.existsSync(jarFile)) { server.status = 'provisioning'; save(); line(`Downloading ${server.loader} ${server.mcVersion}…`); const response = await fetch(await resolveJar(server.loader, server.mcVersion), { headers: { 'user-agent': 'VyronHosting/1.0 (https://vyronhosting.com)' } }); if (!response.ok) throw new Error(`${server.loader} download returned ${response.status}`); fs.writeFileSync(`${jarFile}.tmp`, Buffer.from(await response.arrayBuffer())); fs.renameSync(`${jarFile}.tmp`, jarFile); line(`${server.loader} download complete.`) } }
const start = async () => { if (child) return; await provision(); players.clear(); server.status = 'starting'; save(); line(`Starting ${server.name} with ${server.loader} ${server.mcVersion}…`); const heap = Math.max(768, Math.floor(Number(server.ramGb) * 1024 - 512)), java = javaFor(server.mcVersion); if (server.loader === 'forge') { fs.writeFileSync(path.join(root, 'user_jvm_args.txt'), `-Xms768M\n-Xmx${heap}M\n`); child = spawn('/bin/bash', ['run.sh', 'nogui'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, JAVA_HOME: path.dirname(path.dirname(java)), PATH: `${path.dirname(java)}:${process.env.PATH || ''}` } }) } else child = spawn(java, ['-Xms768M', `-Xmx${heap}M`, '-jar', 'server.jar', '--nogui'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; const capture = (chunk, error = false) => { if (error) stderr += chunk; else stdout += chunk; let target = error ? stderr : stdout; const rows = target.split(/\r?\n/); target = rows.pop() || ''; if (error) stderr = target; else stdout = target; rows.forEach(line) }; child.stdout.on('data', chunk => capture(chunk.toString())); child.stderr.on('data', chunk => capture(chunk.toString(), true)); child.on('exit', code => { line(`Server process stopped with code ${code}.`); child = null; players.clear(); if (server) { server.status = 'stopped'; server.playersOnline = 0; save() } }); child.on('error', error => line(`Start failed: ${error.message}`)) }
const stop = async force => { if (!child) { if (server) { server.status = 'stopped'; save() } return }; server.status = 'stopping'; save(); if (!force && child.stdin.writable) child.stdin.write('stop\n'); else child.kill('SIGKILL'); await new Promise(resolve => { const timer = setTimeout(() => { child?.kill('SIGKILL'); resolve() }, 30000); child?.once('exit', () => { clearTimeout(timer); resolve() }) }) }
const publicServer = () => server && ({ ...server, running: Boolean(child), playersOnline: players.size, badge: server.status })

const api = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' })
    if (req.method === 'GET' && url.pathname === '/api/servers') return json(res, 200, { servers: server ? [publicServer()] : [] })
    if (req.method === 'POST' && url.pathname === '/api/servers') { if (server) return json(res, 409, { error: 'A server already exists in this node.' }); const input = await body(req), loader = String(input.loader || '').toLowerCase(); if (!input.name || !['paper','vanilla','purpur','fabric','folia','forge'].includes(loader) || !/^1\.(20|21)(\.\d+)?$/.test(input.mcVersion)) return json(res, 400, { error: 'Invalid Minecraft server configuration.' }); server = { id: input.id || 'primary', name: String(input.name).slice(0, 48), loader, mcVersion: input.mcVersion, version: `${input.mcVersion} ${loader}`, port: Number(input.port) || 25565, ramGb: Number(input.ramGb) || 2, autoStart: input.autoStart !== false, status: 'stopped', playersOnline: 0, maxPlayers: Math.min(200, Math.max(1, Number(input.maxPlayers) || 20)), motd: String(input.motd || 'A Vyron Minecraft Server').replace(/[\r\n=]/g, ' ').slice(0, 80), createdAt: new Date().toISOString() }; save(); line('Server created from Vyron API.'); return json(res, 201, { server: publicServer() }) }
    const match = url.pathname.match(/^\/api\/servers\/([^/]+)(?:\/(.*))?$/)
    if (!match || !server || match[1] !== server.id) return json(res, 404, { error: 'Server not found.' })
    const route = match[2] || ''
    if (req.method === 'POST' && route === 'action') { const input = await body(req), action = String(input.action || ''); if (!['start', 'stop', 'restart', 'crash'].includes(action)) return json(res, 400, { error: 'Invalid action.' }); if (action === 'start') void start().catch(error => { line(error.message); server.status = 'failed'; save() }); else if (action === 'stop') await stop(false); else if (action === 'crash') await stop(true); else { await stop(false); setTimeout(() => void start().catch(error => line(error.message)), 1200) } return json(res, 200, { server: publicServer() }) }
    if (req.method === 'GET' && route === 'console') return json(res, 200, { running: Boolean(child), status: server.status, badge: server.status, lines: logs.slice(-Math.min(400, Math.max(20, Number(url.searchParams.get('limit')) || 160))) })
    if (req.method === 'POST' && route === 'console/command') { const input = await body(req), command = String(input.command || '').trim(); if (!child || !child.stdin.writable) return json(res, 400, { error: 'Server is not running.' }); if (!command || command.length > 300) return json(res, 400, { error: 'Command is required.' }); child.stdin.write(`${command}\n`); line(`> ${command}`); return json(res, 200, { ok: true, method: 'stdin' }) }
    if (req.method === 'GET' && route === 'players') return json(res, 200, { online: [...players].map(name => ({ name })), count: players.size, maxPlayers: server.maxPlayers })
    return json(res, 404, { error: 'Not found.' })
  } catch (error) { line(`[API] ${error.message}`); json(res, 500, { error: error.message }) }
})

api.listen(port, '127.0.0.1', () => { line(`Vyron Minecraft API listening on ${port}.`); if (server?.autoStart) void start().catch(error => line(error.message)) })
