/**
 * Print the events a recorded fixture maps to.
 *
 * Tests assert specific properties; this shows the whole stream, which is what
 * you want when adding an agent or when a recording changes shape after an
 * agent upgrade.
 *
 *   pnpm --filter @dukebox/adapters inspect file-edit
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JsonlReader } from '@/jsonl'
import { ClaudeCodeMapper } from '@/claude-code/mapper'

function truncate(value: string, length: number): string {
  const collapsed = value.replace(/\n/g, '\\n')
  return collapsed.length > length ? `${collapsed.slice(0, length)}…` : collapsed
}

function main() {
  const name = process.argv[2]
  if (!name) {
    console.error('usage: inspect <fixture-name>')
    process.exit(1)
  }

  const path = fileURLToPath(new URL(`../../fixtures/${name}.jsonl`, import.meta.url))
  const reader = new JsonlReader({
    onMalformed: (line) => console.error(`malformed: ${truncate(line, 60)}`),
  })

  const messages = [...reader.push(readFileSync(path, 'utf8')), ...reader.flush()]
  const mapper = new ClaudeCodeMapper()

  console.log(`${messages.length} stream messages\n`)

  let count = 0
  for (const message of messages) {
    for (const event of mapper.map(message)) {
      count += 1

      let detail: string
      switch (event.type) {
        case 'assistant_text':
        case 'thinking':
          detail = truncate(event.delta, 60)
          break
        case 'tool_call':
          detail = `${event.name} ${truncate(JSON.stringify(event.input), 50)}`
          break
        case 'tool_result':
          detail = `${event.isError ? 'ERROR ' : ''}${truncate(event.output, 50)}`
          break
        case 'usage':
          detail = `in=${event.inputTokens} out=${event.outputTokens}${
            event.costUsd === undefined ? '' : ` $${event.costUsd.toFixed(4)}`
          }`
          break
        default:
          detail = truncate(JSON.stringify(event), 60)
      }

      console.log(`${event.type.padEnd(18)} ${detail}`)
    }
  }

  console.log(`\n${count} events`)
  console.log(`agent session id: ${mapper.agentSessionId ?? '(none)'}`)
}

main()
