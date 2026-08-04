import { applyEvents, emptyTranscript, type EnvelopedEvent } from '@dukebox/protocol'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Composer } from './components/Composer.js'
import { Transcript } from './components/Transcript.js'
import { Workspace } from './components/Workspace.js'
import { NewSession } from './screens/NewSession.js'
import './styles.css'

/**
 * The transcript, rendered against a scripted session.
 *
 * Not part of the app: this exists so the conversation can be looked at in a
 * browser without a server, a container, or an agent. Reached at /preview.html.
 */

const SESSION = '00000000-0000-4000-8000-000000000000'
let seq = 0

const event = (event: EnvelopedEvent['event']): EnvelopedEvent => ({
  seq: (seq += 1),
  sessionId: SESSION,
  ts: Date.now(),
  event,
})

const script: EnvelopedEvent[] = [
  event({ type: 'session_started', agentId: 'claude-code', model: 'claude-opus-4' }),
  event({ type: 'thinking', delta: 'The parser drops the frame header. ' }),
  event({ type: 'thinking', delta: 'Worth checking how exec differs from execStream.' }),
  event({ type: 'assistant_text', delta: 'I found it. ' }),
  event({ type: 'assistant_text', delta: '`execStream` never demultiplexes Docker’s output, ' }),
  event({ type: 'assistant_text', delta: 'so the 8-byte frame headers reach the JSON parser.' }),
  event({
    type: 'tool_call',
    id: 'read-1',
    name: 'Read',
    input: { file_path: 'packages/sandbox/src/container.ts' },
  }),
  event({
    type: 'tool_result',
    id: 'read-1',
    output: 'const raw = await exec.start({ hijack: true, stdin: true })',
    isError: false,
  }),
  event({ type: 'tool_call', id: 'bash-1', name: 'Bash', input: { command: 'pnpm test sandbox' } }),
  event({ type: 'tool_result', id: 'bash-1', output: 'FAIL  1 test failed', isError: true }),
  event({
    type: 'file_diff',
    path: 'packages/sandbox/src/container.ts',
    before: [
      'export class Container {',
      '  async execStream(command: string[]) {',
      '    const exec = await this.container.exec({ Cmd: command })',
      '    const raw = await exec.start({ hijack: true, stdin: true })',
      '    return raw',
      '  }',
      '}',
    ].join('\n'),
    after: [
      'export class Container {',
      '  async execStream(command: string[]) {',
      '    const exec = await this.container.exec({ Cmd: command })',
      '    const raw = await exec.start({ hijack: true, stdin: true })',
      '    const stdout = new PassThrough()',
      '    const stderr = new PassThrough()',
      '    this.docker.modem.demuxStream(raw, stdout, stderr)',
      '    stderr.resume()',
      '    return Duplex.from({ readable: stdout, writable: raw })',
      '  }',
      '}',
    ].join('\n'),
  }),
  event({
    type: 'file_diff',
    path: 'packages/sandbox/src/demux.test.ts',
    before: null,
    after: "it('strips docker frame headers', () => {})",
  }),
  event({
    type: 'permission_request',
    id: 'perm-1',
    action: 'run `git push origin duke/fix-demux`',
    detail: {},
  }),
  event({ type: 'usage', inputTokens: 12_400, outputTokens: 890, costUsd: 0.089 }),
  event({ type: 'error', message: 'Retrying after a rate limit.', fatal: false }),
]

/**
 * A client that answers without a server.
 *
 * Only the calls the dialog makes are implemented; the rest would be scaffolding
 * for something nothing here calls.
 */
const fakeClient = {
  listRepositories: async () => [
    {
      fullName: 'diegodev18/dukebox',
      defaultBranch: 'main',
      isPrivate: false,
      updatedAt: '',
      isRegistered: true,
    },
    {
      fullName: 'diegodev18/duke-site',
      defaultBranch: 'main',
      isPrivate: true,
      updatedAt: '',
      isRegistered: false,
    },
  ],
  createProject: async () => {
    throw new Error('the preview does not talk to a server')
  },
  startSession: async () => {
    throw new Error('the preview does not talk to a server')
  },
} as never

/**
 * Pinned to a desktop size rather than the viewport, so the layout can be
 * judged in a browser window of any size. The real app is measured by the
 * Tauri window instead.
 */
function Preview() {
  const transcript = applyEvents(emptyTranscript(), script)
  const [creating, setCreating] = useState(false)

  return (
    <div
      className="grid grid-cols-[236px_minmax(0,1fr)_clamp(340px,30vw,460px)]"
      style={{ width: 1440, height: '100svh' }}
    >
      <div className="border-r border-border bg-surface p-2">
        <button
          onClick={() => setCreating(true)}
          className="w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left font-medium hover:bg-muted"
        >
          New session
        </button>
      </div>

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-2.5 border-b border-border px-4.5 py-2.5">
          <h1 className="truncate font-medium">Fix the demux bug</h1>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-running motion-safe:animate-pulse" />
            claude-code
          </span>
        </header>

        <Transcript
          transcript={{ ...transcript, running: true }}
          onRespond={(id, allow) => console.log('respond', id, allow)}
        />

        <Composer
          onSend={(text) => console.log('send', text)}
          onInterrupt={() => console.log('interrupt')}
          running={false}
        />
      </div>

      <Workspace
        session={
          {
            id: SESSION,
            title: 'Fix the demux bug',
            status: 'running',
            agentId: 'claude-code',
            branch: 'duke/fix-demux',
            baseBranch: 'main',
            changedFileCount: transcript.files.length,
            lastSeq: transcript.lastSeq,
          } as never
        }
        files={transcript.files}
      />

      {creating && (
        <NewSession
          client={fakeClient}
          projects={[]}
          onCancel={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      )}
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
