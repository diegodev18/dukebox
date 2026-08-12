import {
  applyEvents,
  emptyTranscript,
  type EnvelopedEvent,
  type SessionSummary,
} from '@dukebox/protocol'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentIcon } from '@/components/AgentIcon'
import { Composer } from '@/components/Composer'
import { Transcript } from '@/components/Transcript'
import { PullRequest } from '@/components/PullRequest'
import { RemoteControl } from '@/components/RemoteControl'
import { Workspace } from '@/components/Workspace'
import {
  applyTerminalMessage,
  drainTab,
  emptyTerminalState,
  removeTab,
  type TerminalState,
} from '@/lib/useTerminals'
import { NewSession } from '@/screens/NewSession'
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
  event({ type: 'permission_mode', mode: 'plan' }),
  event({ type: 'thinking', delta: 'The parser drops the frame header. ' }),
  event({ type: 'thinking', delta: 'Worth checking how exec differs from execStream.' }),
  event({
    type: 'assistant_text',
    delta: [
      'I found it.',
      '',
      '`execStream` never demultiplexes Docker’s output, so the 8-byte frame headers reach the JSON parser.',
      '',
      'Two things to fix:',
      '',
      '1. Call `demuxStream` before reading',
      '2. Resume `stderr` so the pipe does not stall',
      '',
      '```ts',
      'this.docker.modem.demuxStream(raw, stdout, stderr)',
      '```',
      '',
    ].join('\n'),
  }),
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
    id: 'perm-plan',
    action: 'exit_plan_mode',
    detail: {},
  }),
  event({
    type: 'permission_request',
    id: 'perm-1',
    action: 'run `git push origin duke/fix-demux`',
    detail: {},
  }),
  event({ type: 'usage', inputTokens: 12_400, outputTokens: 890, costUsd: 0.089 }),
  event({ type: 'error', message: 'Retrying after a rate limit.', fatal: false }),

  // Enough turns to overflow the column. A transcript that grows the window
  // instead of scrolling is only visible once there is more than fits.
  ...Array.from({ length: 12 }, (_, turn) => [
    event({ type: 'assistant_text', delta: `Turn ${turn + 1}: checking the next call site.` }),
    event({
      type: 'tool_call',
      id: `loop-${turn}`,
      name: 'Grep',
      input: { pattern: 'execStream', path: 'packages/sandbox' },
    }),
    event({ type: 'tool_result', id: `loop-${turn}`, output: '3 matches', isError: false }),
  ]).flat(),

  // And enough files to overflow the workspace panel, which has the same
  // shrink-to-fit problem and needs the same check.
  ...Array.from({ length: 25 }, (_, index) =>
    event({
      type: 'file_diff',
      path: `packages/sandbox/src/generated/module-${index}.ts`,
      before: null,
      after: `export const module${index} = ${index}`,
    }),
  ),

  // Leave one tool open so the transcript shows a live thinking-orb on the
  // tool row and another at the tail while `running` is true.
  event({
    type: 'tool_call',
    id: 'grep-live',
    name: 'Grep',
    input: { pattern: 'demuxStream', path: 'packages/sandbox' },
  }),
]

const SETUP_PROMPT = `You are configuring a Dukebox development environment for this repository.

Inspect the repository (package managers, lockfiles, README, CI, .env.example, docker-compose, etc.) and propose:
1. setup — shell commands to install dependencies and prepare the workspace (run once when a session starts)
2. env — environment variable NAMES the project needs, with whether each is a secret and a short description. Never invent or guess actual secret values.
3. instructions — optional short guidance for coding agents in later sessions
4. image — optional container image if the default dukebox/base-node:latest is wrong

Write ONLY this JSON object to /tmp/dukebox-env-proposal.json (create/overwrite that file). Do not commit anything. Do not modify files in the repository.

JSON shape:
{
  "setup": ["pnpm install"],
  "env": {
    "DATABASE_URL": { "secret": true, "description": "Postgres connection string" }
  },
  "instructions": "optional string",
  "image": "optional string"
}

After writing the file, briefly confirm what you proposed.`

const setupScript: EnvelopedEvent[] = [
  event({ type: 'session_started', agentId: 'claude-code', model: 'claude-opus-4' }),
  event({ type: 'user_prompt', text: SETUP_PROMPT }),
  event({ type: 'thinking', delta: 'Looking for package managers and env examples.' }),
  event({
    type: 'tool_call',
    id: 'setup-bash-1',
    name: 'Bash',
    input: { command: 'ls -la && cat package.json' },
  }),
  event({
    type: 'tool_result',
    id: 'setup-bash-1',
    output: 'package.json\npnpm-lock.yaml\nREADME.md',
    isError: false,
  }),
  event({
    type: 'assistant_text',
    delta: 'Proposed `pnpm install` and a couple of env vars. Review them in the Environment tab.',
  }),
  event({ type: 'done', reason: 'completed' }),
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
  listBranches: async () => ['main', 'develop'],
  listEnvironments: async () => [
    {
      id: '00000000-0000-4000-8000-000000000030',
      projectId: '00000000-0000-4000-8000-000000000010',
      name: 'Default',
      branchPattern: '**',
      position: 0,
      hasConfig: true,
      hasSnapshot: false,
      hasDraft: false,
    },
  ],
  listOpencodeProviders: async () => [
    {
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic',
      models: [{ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' }],
    },
  ],
  createProject: async () => {
    throw new Error('the preview does not talk to a server')
  },
  startSession: async () => {
    throw new Error('the preview does not talk to a server')
  },
  getEnvironmentProposal: async () => ({
    setup: ['pnpm install', 'pnpm exec turbo run build'],
    env: {
      DATABASE_URL: { secret: true, description: 'Postgres connection string' },
      REDIS_URL: { secret: true, description: 'Redis connection string' },
    },
    instructions: 'Use pnpm; prefer turbo for package scripts.',
  }),
  getEnvironment: async () => ({
    config: null,
    draft: null,
    secretNames: [] as string[],
  }),
  putEnvironment: async () => {
    console.log('environment saved')
  },
} as never

/** A session's worth of terminal output, as a real shell would paint it. */
const TERMINAL_SCRIPT = [
  'node@dukebox:/workspace/repo$ pnpm test\r\n',
  '\r\n',
  ' \u001b[32m✓\u001b[0m packages/protocol/src/commands.test.ts (8)\r\n',
  ' \u001b[32m✓\u001b[0m apps/server/src/sessions/terminals.test.ts (17)\r\n',
  '\r\n',
  ' Test Files  \u001b[32m2 passed\u001b[0m (2)\r\n',
  '\r\n',
  'node@dukebox:/workspace/repo$ ',
].join('')

/**
 * Base64 that survives non-latin1 text.
 *
 * `btoa` alone throws on the check marks in the script above, the same way it
 * would on anything a real shell prints outside ASCII.
 */
function encodeOutput(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

/**
 * A terminal with no server behind it.
 *
 * Input is echoed locally so typing visibly does something — enough to exercise
 * the panel, the tabs, and the xterm wiring without a container.
 */
function usePreviewTerminals() {
  const [state, setState] = useState<TerminalState>(() =>
    applyTerminalMessage(
      applyTerminalMessage(emptyTerminalState(), {
        type: 'terminal_opened',
        sessionId: SESSION,
        terminalId: 'preview-terminal',
        title: '1',
        cols: 80,
        rows: 24,
      }),
      {
        type: 'terminal_output',
        sessionId: SESSION,
        terminalId: 'preview-terminal',
        data: encodeOutput(TERMINAL_SCRIPT),
      },
    ),
  )

  const emit = (terminalId: string, text: string) =>
    setState((current) =>
      applyTerminalMessage(current, {
        type: 'terminal_output',
        sessionId: SESSION,
        terminalId,
        data: encodeOutput(text),
      }),
    )

  return {
    terminals: state,
    onOpenTerminal: () => {
      const terminalId = `preview-terminal-${state.tabs.length + 1}`

      setState((current) =>
        applyTerminalMessage(current, {
          type: 'terminal_opened',
          sessionId: SESSION,
          terminalId,
          title: String(current.tabs.length + 1),
          cols: 80,
          rows: 24,
        }),
      )

      emit(terminalId, 'node@dukebox:/workspace/repo$ ')
    },
    onAttachTerminal: () => {},
    onDetachTerminal: () => {},
    onTerminalInput: (terminalId: string, data: string) => {
      // A real PTY echoes what it receives; without this the preview looks
      // like a terminal that ignores the keyboard.
      const typed = atob(data)
      emit(terminalId, typed === '\r' ? '\r\nnode@dukebox:/workspace/repo$ ' : typed)
    },
    onTerminalResize: () => {},
    onCloseTerminal: (terminalId: string) => setState((current) => removeTab(current, terminalId)),
    onDrainTerminal: (terminalId: string) => setState((current) => drainTab(current, terminalId)),
  }
}

/**
 * Pinned to a desktop size rather than the viewport, so the layout can be
 * judged in a browser window of any size. The real app is measured by the
 * Tauri window instead.
 */
function Preview() {
  const codingTranscript = applyEvents(emptyTranscript(), script)
  const setupTranscript = applyEvents(emptyTranscript(), setupScript)
  const [view, setView] = useState<'new' | 'coding' | 'setup'>('setup')
  const terminals = usePreviewTerminals()

  const codingSession = {
    id: SESSION,
    projectId: SESSION,
    title: 'Fix the demux bug',
    status: 'running',
    purpose: 'coding',
    agentId: 'claude-code',
    branch: 'duke/fix-demux',
    baseBranch: 'main',
    // Zero on purpose: this is what the server reports for a session whose
    // summary has not refreshed since the agent started editing. The pull
    // request button has to appear anyway, off the live count.
    changedFileCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSeq: codingTranscript.lastSeq,
    pullRequestUrl: null,
    environmentId: null,
    permissionMode: 'plan',
    remoteControlUrl: null,
  } as SessionSummary

  const setupSession = {
    id: '00000000-0000-4000-8000-000000000001',
    projectId: SESSION,
    title: 'Configure environment',
    status: 'done',
    purpose: 'environment_setup',
    agentId: 'claude-code',
    branch: 'duke/0686ed25',
    baseBranch: 'main',
    changedFileCount: 0,
    createdAt: Date.now() - 58_000,
    updatedAt: Date.now(),
    lastSeq: setupTranscript.lastSeq,
    pullRequestUrl: null,
    environmentId: null,
    permissionMode: 'bypass',
    remoteControlUrl: null,
  } as SessionSummary

  const activeSession = view === 'setup' ? setupSession : codingSession
  const activeTranscript = view === 'setup' ? setupTranscript : codingTranscript

  return (
    <div
      className={`grid h-full overflow-hidden ${
        view === 'new'
          ? 'grid-cols-[236px_minmax(0,1fr)]'
          : 'grid-cols-[236px_minmax(0,1fr)_clamp(340px,30vw,460px)]'
      }`}
      style={{ width: 1440 }}
    >
      <div className="border-r border-border bg-surface p-2">
        <button
          onClick={() => setView('new')}
          className="w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left font-medium hover:bg-muted"
        >
          New session
        </button>
        <button
          onClick={() => setView('coding')}
          className="mt-1 w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Fix the demux bug
        </button>
        <button
          onClick={() => setView('setup')}
          className="mt-1 w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Configure environment
        </button>
      </div>

      {view === 'new' ? (
        <NewSession
          client={fakeClient}
          identity={null}
          connection={{
            serverName: 'debian-gp-micro-mia-01',
            address: { host: 'debian-gp-micro-mia-01.tail1a2b3c.ts.net', port: 8787, tls: false },
            deviceId: '00000000-0000-4000-8000-000000000020',
            deviceToken: 'preview',
            pairedAt: Date.now(),
          }}
          projects={[
            {
              id: '00000000-0000-4000-8000-000000000010',
              repoFullName: 'diegodev18/dukebox',
              defaultBranch: 'main',
              environmentCount: 1,
              createdAt: Date.now(),
              sessionCount: 1,
            },
          ]}
          onCreated={() => setView('coding')}
          onConfigureProviders={() => undefined}
        />
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-col">
            <header className="flex items-center gap-2.5 border-b border-border px-4.5 py-2.5">
              <h1 className="truncate font-medium">{activeSession.title}</h1>
              <span className="flex-1" />
              {view === 'coding' && (
                <RemoteControl
                  session={codingSession}
                  enabled
                  url="https://claude.ai/code/session_01ABC"
                  onChange={(enabled) => console.log('remote', enabled)}
                />
              )}
              {view === 'coding' && (
                <PullRequest
                  client={fakeClient}
                  session={codingSession}
                  changedFiles={codingTranscript.files.length}
                  onOpened={(url) => console.log('opened', url)}
                />
              )}

              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <span
                  className={`size-1.5 rounded-full ${
                    view === 'coding'
                      ? 'bg-running motion-safe:animate-pulse'
                      : 'bg-done opacity-50'
                  }`}
                />
                <AgentIcon agentId="claude-code" />
              </span>
            </header>

            <Transcript
              transcript={{ ...activeTranscript, running: view === 'coding' }}
              onRespond={(id, allow) => console.log('respond', id, allow)}
              purpose={activeSession.purpose}
              running={view === 'coding'}
              status={activeSession.status}
            />

            <Composer
              onSend={(text) => console.log('send', text)}
              onInterrupt={() => console.log('interrupt')}
              running={false}
              {...(view === 'coding'
                ? {
                    permissionMode: 'auto' as const,
                    onPermissionModeChange: (mode) => console.log('mode', mode),
                  }
                : {})}
              {...(view === 'setup' ? { placeholder: 'Add context for the setup agent…' } : {})}
            />
          </div>

          <Workspace
            session={activeSession}
            files={activeTranscript.files}
            {...terminals}
            environmentReview={
              view === 'setup'
                ? {
                    client: fakeClient,
                    projectId: setupSession.projectId,
                    sessionId: setupSession.id,
                    environmentId: '00000000-0000-4000-8000-0000000000e1',
                    environmentName: 'Refactors',
                    onSaved: () => console.log('environment saved'),
                  }
                : null
            }
          />
        </>
      )}
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
