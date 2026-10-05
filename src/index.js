/**
 * dsh-plugin-pyrun — Python quick-exec tool for DeepSeek Harness.
 *
 * Registers a `python` tool that pipes the model's source straight to
 * `python -X utf8 -u -` over stdin: no shell quoting layer, one call instead of
 * write-then-run, and UTF-8 on both streams end to end. Background runs
 * register with the generic `ctx.jobs` runtime and are collected with the
 * `job_output` / `job_kill` tools.
 *
 * Ported to the @deepseek-ai/dsh 0.2.x runtime contract (contract basis:
 * deepseek-harness @ 5badb15009 = 0.2.1-alpha.1; the 0.1.5-rc.2 world this
 * plugin grew up in is described historically in the README).
 *
 * @module dsh-plugin-pyrun
 */

import { isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'

export const name = 'dsh-plugin-pyrun'

/** `tools` registers the tool, `shell` executes it, `shellEnv` supplies the managed DSH_* facts. */
export const inject = ['tools', 'shell', 'shellEnv']

/**
 * The stdin-piped interpreter command. `-X utf8` forces UTF-8 mode, `-u` keeps
 * both streams unbuffered, and the trailing exit forwarder repairs the exit code
 * `pwsh -Command` otherwise collapses to 1 for native commands. A bash executor
 * propagates the exit code itself, so it gets the bare command.
 */
const PY_CMD = process.platform === 'win32'
  ? 'python -X utf8 -u -; exit $LASTEXITCODE'
  : 'python -X utf8 -u -'

/** Foreground stdout capture budget; stderr keeps the executor's own cap. */
const STDOUT_MAX_BYTES = 524288

/** Job label: the first non-empty source line, bounded for one-line roster rows. */
function jobLabel(code) {
  const first = code.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '(empty program)'
  return first.length > 72 ? `${first.slice(0, 72)}…` : first
}

/** Sandbox facts worth the terminal detail: a runner that never ran the program, or a denial with this composition's escalation hint. */
function sandboxNotes(sandbox, escalationModes) {
  if (sandbox?.runnerFailed) {
    return [`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`]
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)]
    if (escalationModes.length > 0) notes.push(escalationHintMarker('program'))
    return notes
  }
  return []
}

/**
 * Map a settled background process onto the generic job-outcome vocabulary:
 * `killed` stays `killed` (the signal when one is known), everything else is
 * `completed` with the exit code as detail — a nonzero Python exit is
 * reported, not failed, exactly like the foreground rendering. Sandbox facts
 * join the detail, since a job's terminal reason is the one line every
 * reader — the model's status line, the roster row — shows.
 */
function processOutcome(proc, escalationModes) {
  const base = proc.status === 'killed'
    ? { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
  const notes = sandboxNotes(proc.sandbox, escalationModes)
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/**
 * The process's non-consuming stream readers (`ShellExecution.observed`) as
 * registry pull sources: the registry pumps them into the job's output ring
 * at its own cadence, and `job_output` renders the deltas with the same
 * `[stderr]` section and dropped-output notices a foreground result shows.
 * They bind lazily because the process spawns inside the starter, after the
 * registry admitted the job; a read before the spawn yields nothing.
 */
function pythonSources(getProc) {
  const source = channel => ({
    channel,
    read: (fromByte) => {
      const live = getProc()
      return live === undefined ? { text: '', nextOffset: fromByte, lossy: false } : live.observed[channel].readFrom(fromByte)
    },
  })
  return [source('stdout'), source('stderr')]
}

/**
 * Adapt asynchronous shell preparation after job admission without exposing
 * a partial process: `start` receives the job-owned cancellation signal, the
 * process is killed when cancellation wins the race against the spawn, and
 * `done` settles the outcome — or `killed` when cancelled before the spawn,
 * or `failed` with the preparation error as detail.
 */
function pythonJob(start, outcome) {
  const controller = new AbortController()
  let proc
  const done = (async () => {
    try {
      proc = await start(controller.signal)
      try {
        if (controller.signal.aborted) proc.kill()
      } finally {
        await proc.done
      }
      return outcome(proc)
    } catch (error) {
      return {
        status: controller.signal.aborted && proc === undefined ? 'killed' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })()
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return
      controller.abort(reason)
      proc?.kill()
    },
    done,
  }
}

/** Append the truncation notice, with its spill path, to one collected stream's text. */
function streamText(output) {
  if (!output.truncated) return output.text
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
}

/** Resolve an explicit workdir first, making a relative one session-cwd-relative; otherwise use the session cwd. */
function resolveWorkdir(modelWorkdir, exec) {
  const headerCwd = exec.agent?.session.header.cwd
  if (modelWorkdir === undefined) return headerCwd
  if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir)
  return modelWorkdir
}

/** Detach the executor result from readonly Service Definition types into plain JSON data. */
function canonicalResult(result) {
  const output = stream => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? { sandbox: result.sandbox } : {},
  }
}

/** The model-facing tool description: sandbox, encoding, exit, timeout and background semantics in one place. */
function pythonDescription(backgroundEnabled) {
  const base = 'Execute Python source code directly, in one step: the code is piped to '
    + '`python -X utf8 -u -` over stdin, so no shell quoting or escaping applies, and both output '
    + 'streams are captured as UTF-8. The program runs under the session file sandbox with the same '
    + 'semantics as the pwsh tool: operations outside the allowed mode are denied and reported with '
    + '`[sandbox: ...]` markers; retry this exact call once with `sandbox_permissions` (the narrowest '
    + 'wider mode that suffices) plus a `justification` to request wider access through user approval. '
    + 'The program cannot read interactive stdin (stdin carries the source itself). Optional `workdir` '
    + 'defaults to the session cwd; optional `timeout_ms` defaults to the executor default and is capped '
    + 'by the deployment maximum. The Python exit code is forwarded exactly (`[exit code: N]` marker); '
    + 'non-zero exits are results, not errors. Long output is tail-truncated with the full stream spilled '
    + 'to a file whose path is reported. '
  return base + (backgroundEnabled
    ? 'Set `run_in_background: true` to start the program as a background job and get its job id immediately; '
      + 'collect incremental output with `job_output` and stop it with `job_kill`. No timeout applies to a '
      + 'background run (omit `timeout_ms`).'
    : 'Background execution is not available in this composition; long-running programs must finish within the timeout.')
}

/** The background branch of the output union: a job id and nothing else. */
const BACKGROUND_BRANCH = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'background' },
    jobId: { type: 'string', required: true },
  },
}

/** The foreground branch of the output union: the collected run. */
const FOREGROUND_BRANCH = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'foreground' },
    exitCode: { type: 'json', required: true },
    signal: { type: 'json', required: true },
    timedOut: { type: 'boolean', required: true },
    aborted: { type: 'boolean', required: true },
    timeoutMs: { type: 'number', required: true },
    stdout: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        text: { type: 'string', required: true },
        truncated: { type: 'boolean', required: true },
        spillPath: { type: 'string' },
      },
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        text: { type: 'string', required: true },
        truncated: { type: 'boolean', required: true },
        spillPath: { type: 'string' },
      },
    },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', required: true },
        denied: { type: 'boolean', required: true },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' },
      },
    },
  },
}

/** Render one settled foreground run: body first, then the marker lines. */
function renderForeground(value, escalationModes) {
  const out = streamText(value.stdout)
  const err = streamText(value.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(python completed with no output)'
  const markers = []
  if (value.sandbox?.denied) {
    markers.push(sandboxDenialMarker(value.sandbox.mode))
    if (escalationModes.length > 0) markers.push(escalationHintMarker('program'))
  }
  if (value.sandbox?.runnerFailed) markers.push('[sandbox: the sandbox runner failed; confinement may not have been applied]')
  if (value.timedOut) markers.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== null) markers.push(`[killed by signal: ${value.signal}]`)
  else if (value.aborted) markers.push('[aborted]')
  else if (value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/** Validate the argument constraints a tool schema cannot express. */
function validatePythonArgs(args) {
  if (args.code.trim().length === 0) throw new Error('invalid code: expected a non-empty string')
  if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) {
    throw new Error(`invalid timeout_ms: expected a positive number, got ${JSON.stringify(args.timeout_ms)}`)
  }
  if (args.run_in_background === true && args.timeout_ms !== undefined) {
    throw new Error('invalid timeout_ms: a background run applies no timeout; omit timeout_ms when run_in_background is true')
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

export function apply(ctx) {
  const jobs = ctx.get('jobs')
  const backgroundEnabled = jobs !== undefined
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('dsh-plugin-pyrun: the mounted shell executor confines but ctx.sandboxPolicy is missing')
  }

  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveStandingPolicy = exec =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE anything
   * executes, delegating the shared fail-closed sequence (strict widening,
   * channel resolution, outcome mapping) to `approveEscalation`. This tool
   * contributes only the composition guard and the approval ingredients.
   */
  const approvePythonEscalation = (mode, justification, exec, standingPolicy) => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode: standingPolicy.mode, subject: 'program' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'python',
        signal: exec.signal,
      },
    )
  }

  ctx.tools.register(defineTool({
    name: 'python',
    description: pythonDescription(backgroundEnabled),
    parameters: {
      code: {
        type: 'string',
        required: true,
        description: 'The Python program to run, verbatim. Executed via stdin as `python -X utf8 -u -`; no shell quoting layer applies.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory for the run. Defaults to the session workspace; a relative path is resolved against it.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Elapsed-time budget in milliseconds; the executor applies its configured default and cap.',
      },
      ...backgroundEnabled ? {
        run_in_background: {
          type: 'boolean',
          description: 'Run in the background and return a job id immediately (collect with `job_output`, stop with `job_kill`). No timeout applies; omit `timeout_ms`.',
        },
      } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: {
          type: 'string',
          enum: [...escalationModes],
          description: 'The wider sandbox mode this program needs. Only valid as a one-shot retry of a call the sandbox just denied; requires `justification` and user approval.',
        },
        justification: {
          type: 'string',
          description: 'Required with `sandbox_permissions`: one sentence for the user explaining why this exact program needs the wider access.',
        },
      } : {},
    },
    output: {
      schema: backgroundEnabled
        ? { oneOf: [BACKGROUND_BRANCH, FOREGROUND_BRANCH] }
        : FOREGROUND_BRANCH,
      render(_args, value) {
        return [{
          type: 'text',
          text: value.kind === 'background'
            ? `started background job ${value.jobId}`
            : renderForeground(value, escalationModes),
        }]
      },
    },
    async execute(args, exec) {
      validatePythonArgs(args)
      const standingPolicy = resolveStandingPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approvePythonEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...standingPolicy, mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec)
      const request = {
        command: PY_CMD,
        ...workdir !== undefined ? { workdir } : {},
        stdin: args.code,
        stdoutMaxBytes: STDOUT_MAX_BYTES,
        dshEnv: ctx.shellEnv.collect(exec),
        ...args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {},
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }
      if (args.run_in_background === true) {
        // Undeclared keys still reach execute, so the schema omission needs its own guard.
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        if (exec.signal.aborted) throw new Error('tool call aborted')
        // No deadline arms a background run: `onExpiry: 'none'` leaves the
        // job's own cancellation as the only way to stop it.
        const spec = ctx.shell.resolve({ ...request, onExpiry: 'none' })
        let proc
        const id = jobs.start({
          kind: 'python',
          label: jobLabel(args.code),
          ...exec.agent !== undefined ? { owner: exec.agent.id } : {},
          // The registry pumps the observed streams into the job's output ring;
          // `job_output` renders the deltas (with `[stderr]` sections) itself.
          output: pythonSources(() => proc),
          run: () => {
            // No exec.signal here: cancellation belongs to the job, not to the
            // tool call that started it. The spawn happens inside this starter,
            // after the registry admitted the job.
            const hooks = pythonJob(
              async (signal) => (proc = await ctx.shell.execute({ ...spec, signal })),
              started => processOutcome(started, escalationModes),
            )
            return { done: hooks.done, cancel: (reason) => hooks.cancel(reason) }
          },
        })
        return { kind: 'background', jobId: id }
      }
      const execution = await ctx.shell.execute(ctx.shell.resolve({ ...request, signal: exec.signal }))
      return canonicalResult(await execution.result())
    },
    presentCall(args) {
      return args.run_in_background === true
        ? { card: 'generic', title: jobLabel(args.code), kind: 'execute', rawInput: args.code }
        : { card: 'terminal', title: 'python', description: jobLabel(args.code), ...args.workdir !== undefined ? { cwd: args.workdir } : {} }
    },
  }))
}
