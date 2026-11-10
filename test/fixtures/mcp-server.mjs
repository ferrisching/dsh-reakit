// Local protocol fixture only. No REA, analysis engine, target execution or network.
import { createInterface } from 'node:readline'
const reader = createInterface({ input: process.stdin })
for await (const line of reader) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  switch (request.method) {
    case 'initialize':
      respond({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh-reakit-fixture', version: '1.0.0' } })
      break
    case 'tools/list':
      respond({ tools: [{ name: 'fixture_echo', description: 'Protocol fixture echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] })
      break
    case 'tools/call':
      respond(request.params.arguments.message === 'fail'
        ? { isError: true, content: [{ type: 'text', text: 'Fixture failure' }] }
        : { content: [{ type: 'text', text: request.params.arguments.message }] })
      break
    case 'ping': respond({}); break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n')
  }
}
