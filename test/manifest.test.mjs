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

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** The harness packages the plugin resolves at runtime and must share with the host. */
const HOST_PROVIDED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-sandbox']

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
