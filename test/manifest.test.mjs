/**
 * Manifest contract for dsh-plugin-pyrun.
 *
 * The harness core packages this plugin imports at runtime MUST NOT be regular
 * `dependencies`. A profile that installs this plugin installs a dependency's
 * regular dependencies — with `nodeLinker: hoisted` it materialises them at the
 * profile root — and a second physical copy of `@deepseek-ai/dsh-tools` mints a
 * second module-local `Symbol('@deepseek-ai/dsh-tools.scheduler')`. The host
 * then fails to find the tool-runtime scheduler under its own symbol and every
 * tool call in the process throws `Cannot read properties of undefined
 * (reading 'prepare')`.
 *
 * They are declared as `peerDependencies` (the runtime contract, satisfied by
 * the host installation) and pinned in `devDependencies` for one reason: this
 * plugin is installed with `link:`, and Node resolves a linked plugin's imports
 * from the plugin's own real path — the `~/.dsh/profiles/node_modules` fallback
 * is not an ancestor of D:/Projects/dsh-plugin-pyrun and is therefore
 * unreachable. pnpm never installs a dependency's devDependencies, so the local
 * copy stays out of the consuming profile. `defineTool` and the sandbox helpers
 * carry no symbol-keyed cross-package state, so this local copy is inert.
 *
 * @module test/manifest.test
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** The harness packages the plugin resolves at runtime and must share with the host. */
const HOST_PROVIDED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-sandbox']

/** The runtime contract this plugin declares: every dsh 0.2.x the peer range must admit. */
const PEER_CONTRACT_RANGE = '^0.2.0-rc.1'
const RUNTIMES_IN_CONTRACT = ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-alpha.1']
const RUNTIMES_OUT_OF_CONTRACT = ['0.1.5-rc.2', '0.1.7-rc.2']

/** The exact harness version the local dev copies are pinned to (the contract basis). */
const DEV_PIN = '0.2.1-alpha.1'

test('host-provided core packages are peer dependencies', () => {
  for (const name of HOST_PROVIDED) {
    assert.ok(
      manifest.peerDependencies?.[name] !== undefined,
      `${name} must be declared in peerDependencies: the host installation provides the single live instance`,
    )
  }
})

test('no host-provided core package is installable by a consuming profile', () => {
  for (const name of HOST_PROVIDED) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      assert.equal(
        manifest[field]?.[name],
        undefined,
        `${name} must not appear in ${field}: the profile would install a second physical copy and split the scheduler Symbol. Use devDependencies instead — a consuming profile never installs a dependency's devDependencies.`,
      )
    }
  }
})

test('the local dev copy stays resolvable for the link: install path', () => {
  for (const name of HOST_PROVIDED) {
    const spec = manifest.devDependencies?.[name]
    assert.ok(
      spec !== undefined,
      `${name} must be a pinned devDependency: a link:-installed plugin resolves its imports from this repository, so without a local copy it fails to load with ERR_MODULE_NOT_FOUND`,
    )
    assert.match(
      spec,
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      `${name} must be pinned exactly, not a range: the local copy must not drift off the harness version it runs against`,
    )
  }
})

test('peer ranges admit exactly the declared 0.2.x runtime family', () => {
  // The boot version gate (app-boot plugin-compatibility.ts) evaluates each
  // @deepseek-ai/dsh-* peer with semver.satisfies(runtime, range, { includePrerelease: true })
  // and skips the whole bundle on a miss, so the range IS the load contract.
  for (const name of HOST_PROVIDED) {
    const range = manifest.peerDependencies?.[name]
    assert.equal(
      range,
      PEER_CONTRACT_RANGE,
      `${name} must declare exactly ${PEER_CONTRACT_RANGE}: an accidental range edit silently re-trips the version gate`,
    )
    for (const runtime of RUNTIMES_IN_CONTRACT) {
      assert.ok(
        semver.satisfies(runtime, range, { includePrerelease: true }),
        `${name} range ${range} must admit dsh ${runtime}`,
      )
    }
    for (const runtime of RUNTIMES_OUT_OF_CONTRACT) {
      assert.ok(
        !semver.satisfies(runtime, range, { includePrerelease: true }),
        `${name} range ${range} must not admit dsh ${runtime}: this plugin no longer carries the 0.1.x contract`,
      )
    }
  }
})

test('the local dev copies are pinned inside the declared contract', () => {
  for (const name of HOST_PROVIDED) {
    const devPin = manifest.devDependencies?.[name]
    assert.equal(
      devPin,
      DEV_PIN,
      `${name} devDependency must stay pinned to the contract-basis version ${DEV_PIN}`,
    )
    assert.ok(
      semver.satisfies(devPin, manifest.peerDependencies[name], { includePrerelease: true }),
      `${name} dev pin ${devPin} falls outside the declared peer range ${manifest.peerDependencies[name]}`,
    )
  }
})
