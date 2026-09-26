/**
 * Provider-neutral job planner. Wire the returned plan into Proxmox, Nomad,
 * Kubernetes or a cloud API. GPU share represents a scheduler quota; VRAM is
 * enforced by the selected NVIDIA MIG/vGPU profile where supported.
 */
export function planDeployment(request) {
  const resources = request.resources
  if (resources.cpu < .5 || resources.cpu > 4) throw new Error('CPU outside allowed range')
  if (resources.ram < .5 || resources.ram > 16) throw new Error('RAM outside allowed range')
  if (resources.vram < 0 || resources.vram > 3) throw new Error('VRAM outside allowed range')
  if (resources.gpuShare < 0 || resources.gpuShare > 50) throw new Error('GPU share outside allowed range')
  return {
    job: crypto.randomUUID(),
    steps: [
      { action: 'reserve', resources },
      { action: 'create-isolated-runtime', image: request.template || 'ubuntu-24.04' },
      { action: 'configure-network', subdomain: request.subdomain },
      { action: 'issue-tls', provider: 'acme' },
      { action: 'run-health-checks' }
    ]
  }
}
