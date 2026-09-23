/**
 * dsh-plugin-pyrun — Python quick-exec tool for DeepSeek Harness.
 *
 * Registers a `python` tool that pipes the model's source straight to
 * `python -X utf8 -u -` over stdin: no shell quoting layer, one call instead of
 * write-then-run, and UTF-8 on both streams end to end. Background runs
 * register with the generic `ctx.jobs` runtime and are collected with the
 * `job_output` / `job_kill` tools.
 *
 * Migrated from the dynamic Cordis plugin `pyrun-1`/`pkg-5`, so this file
 * targets the @deepseek-ai/dsh 0.1.5-rc.2 runtime contract (see README for the
 * 0.1.6+ migration table).
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

/** Map a settled background process onto the generic job-outcome vocabulary. */
function processOutcome(proc) {
  if (proc.status === 'killed') {
    return { status: 'killed', detail: proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit' }
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` }
}

/** Shape one background-process read into the `job_output` delta, with loss and sandbox notices appended. */
function renderProcessRead(read, sandbox) {
  const notices = []
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter(path => path !== undefined)
    notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`)
  }
  if (sandbox?.runnerFailed) {
    notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`)
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode))
    notices.push(escalationHintMarker('program'))
  }
  if (notices.length === 0) return read.delta
  const separator = read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : ''
  return `${read.delta}${separator}${notices.join('\n')}`
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
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'python',
            label: jobLabel(args.code),
            ...exec.agent !== undefined ? { owner: exec.agent } : {},
            run: () => {
              // No exec.signal here: cancellation belongs to the job, not to the
              // tool call that started it.
              const proc = ctx.shell.start(ctx.shell.resolve(request))
              return {
                cancel: () => void proc.kill(),
                done: proc.done.then(() => processOutcome(proc)),
                readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox),
              }
            },
          }),
        }
      }
      const result = await ctx.shell.run(ctx.shell.resolve({ ...request, signal: exec.signal }))
      return canonicalResult(result)
    },
    presentCall(args) {
      return args.run_in_background === true
        ? { card: 'generic', title: jobLabel(args.code), kind: 'execute', rawInput: args.code }
        : { card: 'terminal', title: 'python', description: jobLabel(args.code), ...args.workdir !== undefined ? { cwd: args.workdir } : {} }
    },
  }))
}
