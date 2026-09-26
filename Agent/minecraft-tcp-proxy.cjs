const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')

const listenPort = Number(process.env.LISTEN_PORT || 25565)
const dataFile = process.env.VYRON_DATA_FILE || '/home/x1/.local/share/vyron/data.json'
const tokenFile = process.env.AGENT_TOKEN_FILE || '/home/x1/.config/vyron/agent-token'
const agentToken = fs.readFileSync(tokenFile, 'utf8').trim()

const readVarInt = (buffer, start) => {
  let value = 0, size = 0
  while (size < 5) {
    if (start + size >= buffer.length) return null
    const byte = buffer[start + size]
    value |= (byte & 0x7f) << (7 * size++)
    if (!(byte & 0x80)) return { value, size }
  }
  throw new Error('Invalid Minecraft handshake')
}

const handshakeHostname = buffer => {
  const packet = readVarInt(buffer, 0)
  if (!packet || buffer.length < packet.size + packet.value) return null
  let offset = packet.size
  const packetId = readVarInt(buffer, offset)
  if (!packetId || packetId.value !== 0) throw new Error('Invalid Minecraft handshake')
  offset += packetId.size
  const protocol = readVarInt(buffer, offset)
  if (!protocol) return null
  offset += protocol.size
  const length = readVarInt(buffer, offset)
  if (!length || buffer.length < offset + length.size + length.value) return null
  offset += length.size
  return buffer.subarray(offset, offset + length.value).toString('utf8').split('\0')[0].replace(/\.$/, '').toLowerCase()
}

const resolveNodeName = hostname => {
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  const nodes = (data.vms || []).filter(vm => vm.template === 'minecraft' && vm.status !== 'deleted')
  const customDomains = new Map((data.domains || []).map(domain => [String(domain.domain || '').toLowerCase(), domain.vmId]))
  const direct = nodes.find(vm => String(vm.domain || '').toLowerCase() === hostname || vm.name === hostname.split('.')[0])
  const custom = nodes.find(vm => vm.id === customDomains.get(hostname))
  const selected = direct || custom || (nodes.length === 1 ? nodes[0] : null)
  if (!selected) throw new Error(`No Minecraft node matches ${hostname}`)
  return selected.name
}

const resolveNodeIp = name => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port: 8790, path: `/v1/vms/${encodeURIComponent(name)}/metrics`, headers: { Authorization: `Bearer ${agentToken}` }, timeout: 10000 }, response => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { body += chunk })
    response.on('end', () => {
      try {
        const result = JSON.parse(body)
        if (response.statusCode !== 200 || !result.ip) throw new Error(result.error || 'Node IP is unavailable')
        resolve(result.ip)
      } catch (error) { reject(error) }
    })
  })
  request.on('timeout', () => request.destroy(new Error('Node lookup timed out')))
  request.on('error', reject)
  request.end()
})

const server = net.createServer(client => {
  let pending = Buffer.alloc(0), connected = false
  const fail = error => {
    console.error(`[minecraft-proxy] ${client.remoteAddress || 'client'}: ${error.message}`)
    client.destroy()
  }
  client.setTimeout(15000, () => fail(new Error('Handshake timed out')))
  client.on('data', async chunk => {
    if (connected) return
    pending = Buffer.concat([pending, chunk])
    if (pending.length > 8192) return fail(new Error('Handshake is too large'))
    try {
      const hostname = handshakeHostname(pending)
      if (!hostname) return
      connected = true
      client.pause()
      client.removeAllListeners('data')
      const nodeName = resolveNodeName(hostname)
      const nodeIp = await resolveNodeIp(nodeName)
      const upstream = net.createConnection({ host: nodeIp, port: 25565 }, () => {
        upstream.write(pending)
        client.pipe(upstream)
        upstream.pipe(client)
        client.setTimeout(0)
        client.resume()
      })
      const close = () => { client.destroy(); upstream.destroy() }
      client.on('error', close)
      upstream.on('error', close)
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      console.log(`[minecraft-proxy] ${hostname} -> ${nodeName} (${nodeIp}:25565)`)
    } catch (error) { fail(error) }
  })
  client.on('error', () => {})
})

server.on('error', error => { console.error(`[minecraft-proxy] ${error.message}`); process.exitCode = 1 })
server.listen(listenPort, '0.0.0.0', () => console.log(`[minecraft-proxy] dynamic gateway listening on 0.0.0.0:${listenPort}`))
