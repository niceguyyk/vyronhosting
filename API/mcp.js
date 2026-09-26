import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const failed = error => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const trimmedOutput = value => {
  const copy = { ...(value || {}) }
  for (const key of ['stdout', 'stderr', 'output']) if (typeof copy[key] === 'string' && copy[key].length > 100_000) copy[key] = `${copy[key].slice(0, 100_000)}\n… output truncated by Vyron MCP`
  return copy
}

export function createVyronMcpServer(context) {
  const { db, user, workspace, apiToken, agentRequest, save, record, creationAvailability, syncVmStates } = context
  const canOperate = apiToken.scopes?.includes('operate') && context.roleRank >= 2
  const canManage = apiToken.scopes?.includes('operate') && context.roleRank >= 3
  const server = new McpServer({ name: 'vyron-hosting', version: '1.0.0' })
  const vmFor = (name, operate = false, manage = false) => {
    if (operate && !canOperate) throw new Error('This MCP token needs the operate scope and Developer access.')
    if (manage && !canManage) throw new Error('This action requires an operate token and Workspace Administrator access.')
    const vm = db.vms.find(item => item.name === name && item.workspaceId === workspace.id && item.status !== 'deleted')
    if (!vm) throw new Error('Node not found in the active workspace.')
    return vm
  }
  const requireRunning = vm => { if (vm.status !== 'running') throw new Error('The node must be running for this action.') }
  const fileScope = vm => ['node', 'nginx'].includes(vm.template) ? 'project' : vm.template === 'minecraft' ? 'minecraft' : 'user'
  const cleanVm = vm => {
    const { userId, initialPassword, uploadPath, rconPassword, ...safe } = vm
    if (safe.minecraft) { const { rconPassword: ignored, ...minecraft } = safe.minecraft; safe.minecraft = minecraft }
    if (safe.metrics) { const { ip, ...metrics } = safe.metrics; safe.metrics = metrics }
    if (safe.runtime) {
      const { environment, ...runtime } = safe.runtime
      safe.runtime = { ...runtime, environmentKeys: environment && typeof environment === 'object' ? Object.keys(environment) : [] }
    }
    return safe
  }
  const tool = (name, definition, handler) => server.registerTool(name, definition, async input => {
    try { return await handler(input) } catch (error) { return failed(error) }
  })

  tool('list_nodes', {
    title: 'List Vyron nodes',
    description: 'List every server node in the authenticated user’s active Vyron workspace, including state, plan, resources and public hostname.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false }
  }, async () => {
    const nodes = db.vms.filter(vm => vm.workspaceId === workspace.id && vm.status !== 'deleted')
    await syncVmStates(nodes)
    return text(nodes.map(vm => cleanVm(vm)))
  })

  tool('get_node', {
    title: 'Inspect a Vyron node', description: 'Get current configuration, deployment state, metrics and recent events for one node.',
    inputSchema: { node: z.string().min(3).max(32) }, annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ node }) => { const vm = vmFor(node); await syncVmStates([vm]); return text(cleanVm(vm)) })

  tool('get_node_metrics', {
    title: 'Read live node metrics', description: 'Read current CPU, memory, storage and network measurements for a running node.',
    inputSchema: { node: z.string().min(3).max(32) }, annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ node }) => {
    const vm = vmFor(node); requireRunning(vm)
    return text(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/metrics`))
  })

  tool('start_node', {
    title: 'Start a Vyron node', description: 'Power on a stopped node. This changes server state and may be blocked during location maintenance.',
    inputSchema: { node: z.string().min(3).max(32) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ node }) => {
    const vm = vmFor(node, true), availability = creationAvailability()
    if (!availability.available) throw new Error(availability.reason)
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/start`, { method: 'POST' })
    vm.status = result.status || 'running'; vm.desiredState = 'running'; save(); record('mcp.node.start', vm.name); return text(result)
  })

  tool('stop_node', {
    title: 'Stop a Vyron node', description: 'Power off a node. Running applications and game servers on it become unavailable.',
    inputSchema: { node: z.string().min(3).max(32) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  }, async ({ node }) => {
    const vm = vmFor(node, true), result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/stop`, { method: 'POST' })
    vm.status = result.status || 'stopped'; vm.desiredState = 'stopped'; save(); record('mcp.node.stop', vm.name); return text(result)
  })

  tool('restart_node', {
    title: 'Restart a Vyron node', description: 'Power-cycle a node by stopping it and starting it again. Its services are briefly unavailable.',
    inputSchema: { node: z.string().min(3).max(32) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, async ({ node }) => {
    const vm = vmFor(node, true), availability = creationAvailability()
    if (!availability.available) throw new Error(availability.reason)
    await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/stop`, { method: 'POST' })
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/start`, { method: 'POST' })
    vm.status = result.status || 'running'; vm.desiredState = 'running'; save(); record('mcp.node.restart', vm.name); return text(result)
  })

  tool('execute_command', {
    title: 'Execute a command', description: 'Run a shell command with the same full guest control as the Vyron web terminal. Use only when the user intends the command and review destructive commands carefully.',
    inputSchema: { node: z.string().min(3).max(32), command: z.string().min(1).max(8000), cwd: z.string().min(1).max(300).default('/root') },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ node, command, cwd }) => {
    const vm = vmFor(node, true); requireRunning(vm)
    if (!cwd.startsWith('/') || cwd.includes('..') || /[\0\r\n]/.test(cwd)) throw new Error('Invalid working directory.')
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/exec`, { method: 'POST', body: JSON.stringify({ command, cwd }) })
    record('mcp.command.execute', vm.name, { command: command.slice(0, 500), cwd }); return text(trimmedOutput(result))
  })

  tool('watch_logs', {
    title: 'Read recent node logs', description: 'Read recent application, Nginx, Minecraft, or system journal output from a running node.',
    inputSchema: { node: z.string().min(3).max(32), lines: z.number().int().min(20).max(400).default(200) }, annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ node, lines }) => {
    const vm = vmFor(node); requireRunning(vm)
    let result
    if (vm.template === 'minecraft') result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/logs?lines=${lines}`)
    else if (['node', 'nginx'].includes(vm.template)) result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/logs?lines=${lines}`)
    else result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/exec`, { method: 'POST', body: JSON.stringify({ command: `journalctl -n ${lines} --no-pager`, cwd: '/root' }) })
    return text(trimmedOutput(result))
  })

  tool('list_files', {
    title: 'List node files', description: 'List files and folders within the node’s managed project, Minecraft, or user file root.',
    inputSchema: { node: z.string().min(3).max(32), path: z.string().max(240).default('.') }, annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ node, path }) => { const vm = vmFor(node); requireRunning(vm); return text(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files?path=${encodeURIComponent(path)}&scope=${fileScope(vm)}`)) })

  tool('read_file', {
    title: 'Read a text file', description: 'Read a UTF-8 text file up to 64 KB from a managed node file root.',
    inputSchema: { node: z.string().min(3).max(32), path: z.string().min(1).max(240) }, annotations: { readOnlyHint: true, destructiveHint: false }
  }, async ({ node, path }) => { const vm = vmFor(node); requireRunning(vm); return text(await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/file?path=${encodeURIComponent(path)}&scope=${fileScope(vm)}`)) })

  tool('write_file', {
    title: 'Create or edit a text file', description: 'Create or replace a UTF-8 text file. Project and Minecraft services restart automatically after the write.',
    inputSchema: { node: z.string().min(3).max(32), path: z.string().min(1).max(240), content: z.string().max(49_152) }, annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ node, path, content }) => {
    const vm = vmFor(node, true); requireRunning(vm)
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/file`, { method: 'PUT', body: JSON.stringify({ path, content, scope: fileScope(vm) }) })
    record('mcp.file.write', vm.name, { path }); return text(result)
  })

  tool('upload_file', {
    title: 'Upload a binary file', description: 'Upload a base64-encoded file up to 10 MB into a managed node file root.',
    inputSchema: { node: z.string().min(3).max(32), path: z.string().min(1).max(240), base64: z.string().min(1).max(14 * 1024 * 1024) }, annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ node, path, base64 }) => {
    const vm = vmFor(node, true); requireRunning(vm)
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Invalid base64 file data.')
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/upload`, { method: 'POST', body: JSON.stringify({ path, data: base64, scope: fileScope(vm) }) })
    record('mcp.file.upload', vm.name, { path, bytes: Buffer.from(base64, 'base64').length }); return text(result)
  })

  tool('create_folder', {
    title: 'Create a folder', description: 'Create a folder, including missing parent folders, inside a managed node file root.',
    inputSchema: { node: z.string().min(3).max(32), path: z.string().min(1).max(240) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async ({ node, path }) => {
    const vm = vmFor(node, true); requireRunning(vm)
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/files/folder`, { method: 'POST', body: JSON.stringify({ path, scope: fileScope(vm) }) })
    record('mcp.folder.create', vm.name, { path }); return text(result)
  })

  tool('delete_path', {
    title: 'Delete a file or folder', description: 'Permanently delete one managed file or folder recursively. confirmation must exactly equal DELETE followed by the path.',
    inputSchema: { node: z.string().min(3).max(32), path: z.string().min(1).max(240), confirmation: z.string().max(260) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, async ({ node, path, confirmation }) => {
    const vm = vmFor(node, true); requireRunning(vm)
    if (confirmation !== `DELETE ${path}`) throw new Error(`Confirmation must exactly equal: DELETE ${path}`)
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/file`, { method: 'DELETE', body: JSON.stringify({ path, scope: fileScope(vm) }) })
    record('mcp.path.delete', vm.name, { path }); return text(result)
  })

  tool('minecraft_command', {
    title: 'Run a Minecraft console command', description: 'Send a command to the managed Minecraft server console.',
    inputSchema: { node: z.string().min(3).max(32), command: z.string().min(1).max(300) }, annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ node, command }) => {
    const vm = vmFor(node, true); requireRunning(vm)
    if (vm.template !== 'minecraft') throw new Error('This node is not a Minecraft server.')
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}/minecraft/command`, { method: 'POST', body: JSON.stringify({ command, rconPassword: vm.minecraft?.rconPassword }) })
    record('mcp.minecraft.command', vm.name, { command }); return text(result)
  })

  tool('delete_node', {
    title: 'Permanently delete a node', description: 'Permanently delete a Vyron node and its managed domains. confirmation must exactly equal DELETE followed by the node name.',
    inputSchema: { node: z.string().min(3).max(32), confirmation: z.string().max(50) }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, async ({ node, confirmation }) => {
    const vm = vmFor(node, true, true)
    if (confirmation !== `DELETE ${vm.name}`) throw new Error(`Confirmation must exactly equal: DELETE ${vm.name}`)
    const result = await agentRequest(`/v1/vms/${encodeURIComponent(vm.name)}`, { method: 'DELETE' })
    db.domains = db.domains.filter(domain => domain.vmId !== vm.id); vm.status = 'deleted'; vm.deletedAt = new Date().toISOString(); save(); record('mcp.node.delete', vm.name); return text(result)
  })

  return server
}
