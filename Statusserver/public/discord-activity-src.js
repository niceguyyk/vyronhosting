import { DiscordSDK } from '@discord/embedded-app-sdk'

const $ = selector => document.querySelector(selector)
const clamp = value => Math.max(0, Math.min(100, Number(value) || 0))
const label = status => status === 'major' ? 'Major incident' : status === 'maintenance' ? 'Maintenance' : 'Operational'

async function connectDiscord() {
  try {
    const response = await fetch('./config', { cache: 'no-store' })
    const { clientId } = await response.json()
    if (!clientId) {
      $('#discord-state').textContent = 'Browser preview'
      return
    }
    const discordSdk = new DiscordSDK(clientId)
    await discordSdk.ready()
    document.documentElement.classList.add('inside-discord')
    $('#discord-state').textContent = 'Live in Discord'
  } catch (error) {
    console.warn('Discord Activity SDK could not initialize', error)
    $('#discord-state').textContent = 'Status view'
  }
}

function render(data) {
  const status = data.status === 'operational' ? 'operational' : data.status === 'major' ? 'major' : 'maintenance'
  $('#overall-dot').className = `status-dot ${status}`
  $('#overall').textContent = status === 'operational' ? 'All systems operational' : label(status)
  $('#updated').textContent = `Updated ${new Date(data.generatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  $('#services').replaceChildren(...(data.services || []).map(service => {
    const item = document.createElement('article')
    const serviceStatus = ['major', 'maintenance'].includes(service.status) ? service.status : 'operational'
    item.className = 'service'
    const name = document.createElement('strong')
    name.textContent = service.name
    const badge = document.createElement('span')
    badge.className = serviceStatus
    badge.textContent = label(serviceStatus)
    item.append(name, badge)
    return item
  }))
  const cpu = clamp(data.metrics?.cpu)
  const memory = data.metrics?.totalRam ? clamp(Number(data.metrics.usedRam || 0) / Number(data.metrics.totalRam) * 100) : 0
  $('#cpu-value').textContent = `${cpu.toFixed(1)}%`
  $('#memory-value').textContent = `${memory.toFixed(1)}%`
  $('#cpu-bar').style.width = `${cpu}%`
  $('#memory-bar').style.width = `${memory}%`
  $('#nodes').textContent = String(data.metrics?.nodes ?? '—')
  const incident = data.activeIncidents?.[0] || data.incidents?.find(item => !item.resolvedAt)
  $('#incident').className = `incident ${incident ? incident.state || 'maintenance' : 'operational'}`
  $('#incident-title').textContent = incident ? incident.title || label(incident.state) : 'No active incidents'
  $('#incident-copy').textContent = incident ? incident.detail || 'Our team is investigating.' : 'The Vyron platform is operating normally.'
}

async function loadStatus() {
  try {
    const response = await fetch('./api/v1/status', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    render(await response.json())
  } catch (error) {
    $('#overall-dot').className = 'status-dot maintenance'
    $('#overall').textContent = 'Status data unavailable'
    $('#updated').textContent = 'Retrying…'
    console.warn('Status refresh failed', error)
  }
}

connectDiscord()
loadStatus()
setInterval(loadStatus, 30_000)
