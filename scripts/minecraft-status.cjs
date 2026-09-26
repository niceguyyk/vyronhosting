const net = require('node:net')
const dns = require('node:dns').promises

const host = process.argv[2] || 'mcc.vyronhosting.com'
let port = Number(process.argv[3] || 25565)
let connectHost = host
const varInt = value => {
  const bytes = []
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}
const readVarInt = (buffer, start = 0) => {
  let value = 0, size = 0
  while (start + size < buffer.length && size < 5) {
    const byte = buffer[start + size]
    value |= (byte & 0x7f) << (7 * size++)
    if (!(byte & 0x80)) return { value, size }
  }
  return null
}
const string = value => {
  const data = Buffer.from(value)
  return Buffer.concat([varInt(data.length), data])
}
const packet = payload => Buffer.concat([varInt(payload.length), payload])
const main = async () => {
  if (!process.argv[3]) {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`).catch(() => [])
    if (records[0]) { connectHost = records[0].name; port = records[0].port }
  }
  const portBuffer = Buffer.alloc(2)
  portBuffer.writeUInt16BE(port)
  const handshake = packet(Buffer.concat([varInt(0), varInt(767), string(host), portBuffer, varInt(1)]))
  const request = packet(varInt(0))
  const socket = net.createConnection({ host: connectHost, port }, () => socket.write(Buffer.concat([handshake, request])))
  let received = Buffer.alloc(0)
  socket.setTimeout(15000, () => socket.destroy(new Error('Minecraft status request timed out')))
  socket.on('data', chunk => {
  received = Buffer.concat([received, chunk])
  const frame = readVarInt(received)
  if (!frame || received.length < frame.size + frame.value) return
  let offset = frame.size
  const id = readVarInt(received, offset); offset += id.size
  const length = readVarInt(received, offset); offset += length.size
  const status = JSON.parse(received.subarray(offset, offset + length.value).toString())
  console.log(JSON.stringify({ host, port, version: status.version?.name, online: status.players?.online, max: status.players?.max, description: status.description }, null, 2))
  socket.end()
  })
  socket.on('error', error => { console.error(error.message); process.exitCode = 1 })
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
