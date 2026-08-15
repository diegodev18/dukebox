import {
  applyEvents,
  emptyTranscript,
  type EnvelopedEvent,
  type SessionSummary,
} from '@dukebox/protocol'
import { StrictMode, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentIcon } from '@/components/AgentIcon'
import { DukeWordmark } from '@/components/Duke'
import { Composer } from '@/components/Composer'
import { ResizeHandle } from '@/components/ResizeHandle'
import { SearchPalette } from '@/components/SearchPalette'
import { Transcript } from '@/components/Transcript'
import { Workspace } from '@/components/Workspace'
import { NAV_DEFAULT, NAV_MIN, WORKSPACE_MIN } from '@/lib/columnWidths'
import { useColumnWidths } from '@/lib/useColumnWidths'
import {
  applyTerminalMessage,
  drainTab,
  emptyTerminalState,
  removeTab,
  renameTab,
  type TerminalState,
} from '@/lib/useTerminals'
import { draftTitle } from '@/lib/newSessionDraft'
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
  event({
    type: 'user_prompt',
    text: 'The JSON parser is choking on docker exec output. Find it and fix it.',
  }),
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
  // Tall enough to virtualize, and sorted after the small files — a later
  // diff that vanished as you scrolled was how the shared-scroller offset
  // bug showed up.
  event({
    type: 'file_diff',
    path: 'packages/sandbox/src/extra.ts',
    before: Array.from({ length: 140 }, (_, i) => `const before${i} = ${i}`).join('\n'),
    after: Array.from({ length: 140 }, (_, i) => `const after${i} = ${i}`).join('\n'),
  }),
  // A plan opens its own workspace tab and is answered from there. Two of
  // them, so the numbering and the tab bar's scroll are visible. Replanning
  // in place needs a denial, which only a real click produces: press "Keep
  // planning" on the second and the next plan takes over its tab.
  event({
    type: 'permission_request',
    id: 'perm-plan-denied',
    action: 'exit_plan_mode',
    detail: {
      plan: [
        '# Strip the demux frame headers',
        '',
        'Rewrite `execStream` to unwrap Docker frames before they reach the caller.',
      ].join('\n'),
    },
  }),
  event({
    type: 'permission_request',
    id: 'perm-plan',
    action: 'exit_plan_mode',
    detail: {
      plan: [
        '# Strip the demux frame headers',
        '',
        'Docker multiplexes stdout and stderr into one stream with an 8-byte',
        'header per frame. The sandbox hands that stream straight to the agent,',
        'so every read starts with binary noise.',
        '',
        '## Steps',
        '',
        '1. Add `demux.ts` with a `PassThrough` that parses the frame header.',
        '2. Use it from `Container.execStream`, keeping the `Duplex` shape.',
        '3. Cover a split frame — a header can arrive across two chunks.',
        '',
        '| File | Change |',
        '| --- | --- |',
        '| `packages/sandbox/src/demux.ts` | New |',
        '| `packages/sandbox/src/container.ts` | Use the parser |',
      ].join('\n'),
    },
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
  ...Array.from({ length: 12 }, (_, turn) =>
    event({ type: 'assistant_text', delta: `Turn ${turn + 1}: checking the next call site.` }),
  ),

  // Consecutive tools fold into one group. Mix of kinds so the summary is
  // "N actions"; the last call stays open so the group auto-expands.
  event({
    type: 'tool_call',
    id: 'explore-read',
    name: 'Read',
    input: { file_path: 'packages/sandbox/src/exec.ts' },
  }),
  event({
    type: 'tool_result',
    id: 'explore-read',
    output: 'export async function execStream() {}',
    isError: false,
  }),
  event({
    type: 'tool_call',
    id: 'explore-glob',
    name: 'Glob',
    input: { pattern: '**/*.{ts,tsx}', path: 'packages/sandbox' },
  }),
  event({
    type: 'tool_result',
    id: 'explore-glob',
    output: 'container.ts\ndemux.test.ts',
    isError: false,
  }),
  event({
    type: 'tool_call',
    id: 'explore-grep',
    name: 'Grep',
    input: { pattern: 'execStream', path: 'packages/sandbox' },
  }),
  event({
    type: 'tool_result',
    id: 'explore-grep',
    output: '3 matches',
    isError: false,
  }),
  event({
    type: 'tool_call',
    id: 'explore-bash',
    name: 'Bash',
    input: { command: 'pnpm test sandbox' },
  }),
  event({
    type: 'tool_result',
    id: 'explore-bash',
    output: 'PASS  12 tests',
    isError: false,
  }),
  event({
    type: 'tool_call',
    id: 'explore-edit',
    name: 'Edit',
    input: { file_path: 'packages/sandbox/src/container.ts' },
  }),
  event({
    type: 'tool_result',
    id: 'explore-edit',
    output: 'updated',
    isError: false,
  }),

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

  // Last call in the exploration group stays open so the group auto-expands
  // with a live Duke; another Duke sits at the tail while `running` is true.
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
  agentCredentialsConfigured: async () => true,
  grokCredentialsConfigured: async () => false,
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
    verification: { ok: true },
  }),
  getEnvironment: async () => ({
    config: null,
    draft: null,
    secretNames: [] as string[],
  }),
  putEnvironment: async () => {
    console.log('environment saved')
  },
  openPullRequest: async () => ({
    url: 'https://github.com/diegodev18/dukebox/pull/1',
    title: 'Fix the demux bug',
    isDraft: true,
    state: 'open' as const,
  }),
  markPullRequestReady: async () => ({
    url: 'https://github.com/diegodev18/dukebox/pull/1',
    title: 'Fix the demux bug',
    isDraft: false,
    state: 'open' as const,
  }),
  mergePullRequest: async () => ({
    url: 'https://github.com/diegodev18/dukebox/pull/1',
    title: 'Fix the demux bug',
    isDraft: false,
    state: 'merged' as const,
  }),
  getPullRequest: async () => ({
    url: 'https://github.com/diegodev18/dukebox/pull/1',
    title: 'Fix the demux bug',
    body: '## Summary\n\nFixes the demux so the last chunk is not dropped.',
    isDraft: false,
    state: 'open' as const,
    mergeable: 'MERGEABLE' as const,
    checks: 'passing' as const,
    checkRuns: [
      { name: 'test', state: 'passing' as const },
      { name: 'typecheck', state: 'passing' as const },
    ],
    commits: [{ sha: 'a1b2c3d4e5f67890', title: 'Fix the demux bug', author: 'diego' }],
    reviews: [{ author: 'ada', state: 'APPROVED' as const, body: 'Nice catch.' }],
    reviewDecision: 'APPROVED' as const,
  }),
  resolvePullRequestConflicts: async () => ({ status: 'resolved' as const }),
  listWorkspaceTree: async () => ['CLAUDE.md', 'src/app.ts'],
  readWorkspaceFile: async (_sessionId: string, path: string) => {
    if (path === 'CLAUDE.md') {
      return {
        path,
        content: '# CLAUDE.md\n\nUse pnpm. Prefer turbo for package scripts.\n',
        binary: false,
        truncated: false,
      }
    }
    return {
      path,
      content: "export function greet() {\n  return 'ok'\n}\n",
      binary: false,
      truncated: false,
    }
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
        title: '047',
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
          title: randomPreviewTitle(current.tabs.map((tab) => tab.title)),
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
    onRenameTerminal: (terminalId: string, title: string) =>
      setState((current) => renameTab(current, terminalId, title)),
    onDrainTerminal: (terminalId: string, count: number) =>
      setState((current) => drainTab(current, terminalId, count)),
  }
}

/** A three-digit tab label, matching what the server assigns. */
function randomPreviewTitle(taken: string[]): string {
  const used = new Set(taken)

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const title = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
    if (!used.has(title)) return title
  }

  return String(Math.floor(Math.random() * 1000)).padStart(3, '0')
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
  const [drafts, setDrafts] = useState<{ id: string; prompt: string }[]>([])
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [composerDraft, setComposerDraft] = useState<{ text: string; key: number } | null>(null)
  const [codingPullRequest, setCodingPullRequest] = useState<SessionSummary['pullRequest']>({
    url: 'https://github.com/diegodev18/dukebox/pull/1',
    title: 'Fix the demux bug',
    isDraft: true,
    state: 'open',
  })
  const terminals = usePreviewTerminals()
  const composing = view === 'new'
  const {
    containerRef,
    navWidth,
    workspaceWidth,
    navMax,
    workspaceMax,
    setNavWidth,
    setWorkspaceWidth,
  } = useColumnWidths(composing)

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
    // request tab still appears off the live file count.
    changedFileCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastSeq: codingTranscript.lastSeq,
    pullRequestUrl: codingPullRequest?.url ?? null,
    pullRequest: codingPullRequest,
    environmentId: null,
    permissionMode: 'plan',
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
    pullRequest: null,
    environmentId: null,
    permissionMode: 'bypass',
  } as SessionSummary

  const activeSession = view === 'setup' ? setupSession : codingSession
  const activeTranscript = view === 'setup' ? setupTranscript : codingTranscript

  const previewProject = {
    id: SESSION,
    repoFullName: 'diegodev18/dukebox',
    defaultBranch: 'main',
    environmentCount: 1,
    createdAt: Date.now(),
    sessionCount: 2,
  }

  const previewSite = {
    id: '00000000-0000-4000-8000-000000000010',
    repoFullName: 'diegodev18/site',
    defaultBranch: 'main',
    environmentCount: 0,
    createdAt: Date.now(),
    sessionCount: 0,
  }

  return (
    <div
      ref={containerRef}
      className={`grid h-full overflow-hidden ${
        view === 'new'
          ? 'grid-cols-[var(--nav-width)_minmax(0,1fr)]'
          : 'grid-cols-[var(--nav-width)_minmax(0,1fr)_var(--workspace-width)]'
      }`}
      style={
        {
          width: 1440,
          '--nav-width': `${navWidth}px`,
          '--workspace-width': `${workspaceWidth}px`,
        } as CSSProperties
      }
    >
      <div className="relative z-10 flex min-h-0 min-w-0 flex-col border-r border-border bg-surface p-2">
        <div className="px-2 pt-1 pb-2">
          <DukeWordmark />
        </div>
        <button
          type="button"
          onClick={() => {
            setActiveDraftId(crypto.randomUUID())
            setView('new')
          }}
          className="w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left font-medium hover:bg-muted"
        >
          New session
        </button>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="mt-1 w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left font-medium hover:bg-muted"
        >
          Search
        </button>
        {drafts.map((draft) => (
          <button
            key={draft.id}
            type="button"
            onClick={() => {
              setActiveDraftId(draft.id)
              setView('new')
            }}
            className="mt-1 w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {draftTitle(draft.prompt)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setView('coding')}
          className="mt-1 w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Fix the demux bug
        </button>
        <button
          type="button"
          onClick={() => setView('setup')}
          className="mt-1 w-full rounded-[calc(var(--radius)*0.7)] px-2 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Configure environment
        </button>
        <ResizeHandle
          value={navWidth}
          min={NAV_MIN}
          max={navMax}
          defaultValue={NAV_DEFAULT}
          edge="end"
          label="Resize sessions"
          onChange={setNavWidth}
        />
      </div>

      {searchOpen && (
        <SearchPalette
          sessions={[codingSession, setupSession]}
          projects={[previewProject, previewSite]}
          role="owner"
          onSelect={(sessionId) => {
            setView(sessionId === SESSION ? 'coding' : 'setup')
            setSearchOpen(false)
          }}
          onNewSession={() => {
            setView('new')
            setSearchOpen(false)
          }}
          onOpenSettings={() => setSearchOpen(false)}
          onDismiss={() => setSearchOpen(false)}
        />
      )}

      {view === 'new' ? (
        <NewSession
          key={activeDraftId ?? 'new'}
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
          initialPrompt={drafts.find((draft) => draft.id === activeDraftId)?.prompt ?? ''}
          onDraftChange={(fields) => {
            const id = activeDraftId
            if (!id) return
            if (!fields.prompt.trim()) {
              setDrafts((current) => current.filter((draft) => draft.id !== id))
              return
            }
            setDrafts((current) => [
              { id, prompt: fields.prompt },
              ...current.filter((draft) => draft.id !== id),
            ])
          }}
        />
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-col">
            <header className="flex items-center gap-2.5 border-b border-border px-4.5 py-2.5">
              <h1 className="truncate font-medium">{activeSession.title}</h1>
              <span className="flex-1" />

              <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <span
                  className={`size-1.5 rounded-full ${
                    view === 'coding'
                      ? 'bg-running motion-safe:animate-pulse'
                      : 'bg-done opacity-50'
                  }`}
                />
                <AgentIcon agentId="grok-build" />
              </span>
            </header>

            {activeSession.pullRequest?.state === 'merged' && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-surface px-4.5 py-2 text-[12.5px] text-muted-foreground">
                <p>
                  This pull request was merged. A message here stays on this branch. For new work,
                  start from {activeSession.baseBranch}.
                </p>
                <button
                  type="button"
                  onClick={() => setView('new')}
                  className="rounded-[calc(var(--radius)*0.6)] border border-border px-2 py-0.5 text-[12px] font-medium text-foreground hover:bg-muted"
                >
                  New session from {activeSession.baseBranch}
                </button>
              </div>
            )}

            <Transcript
              transcript={{ ...activeTranscript, running: view === 'coding' }}
              onRespond={(id, allow) => console.log('respond', id, allow)}
              onEdit={(text) => setComposerDraft({ text, key: Date.now() })}
              purpose={activeSession.purpose}
              running={view === 'coding'}
              status={activeSession.status}
            />

            <Composer
              onSend={(text) => console.log('send', text)}
              onInterrupt={() => console.log('interrupt')}
              running={false}
              {...(composerDraft ? { draft: composerDraft } : {})}
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
            client={fakeClient}
            width={workspaceWidth}
            onWidthChange={setWorkspaceWidth}
            widthMin={WORKSPACE_MIN}
            widthMax={workspaceMax}
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
            pullRequest={
              view === 'coding'
                ? {
                    client: fakeClient,
                    onUpdated: (patch) => {
                      setCodingPullRequest(patch.pullRequest)
                      console.log('pr updated', patch)
                    },
                    onContinue: () => setView('new'),
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
