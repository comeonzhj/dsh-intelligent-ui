#!/usr/bin/env node
/**
 * Build `client.js` — the browser half of Intelligent UI.
 *
 * No bundler, no dependencies: the client half of a DSH plugin is a CommonJS
 * closure registered with the page's module loader, and the modules this plugin
 * is written in are plain ES modules with a single, mechanical difference
 * (their `import`/`export` lines). Flattening them into one scope therefore
 * takes a few regular expressions, and the result has no build-time coupling to
 * the harness at all.
 *
 * Two artifacts come out of one run:
 *
 *   * `client.js` — the servable bundle. It carries the flattened modules, the
 *     pre-computed **runner source** (the same modules plus the lockdown, shipped
 *     as a string so the sandbox can be built from a Blob), and the plugin entry.
 *   * nothing else. The Host half (`index.js`) imports `lib/*.js` directly.
 *
 * @module intelligent-ui/scripts/build-client
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

import { workerSource, lockdownSource } from '../src/runtime/runtime.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** The package name; also the module-loader id the page resolves this bundle by. */
const PACKAGE_NAME = '@comeonzhj/dsh-intelligent-ui'

/** Modules that make up the browser half, in dependency order. */
const PAGE_MODULES = [
  'lib/catalog.js',
  'lib/compile.js',
  'lib/composite.js',
  'src/runtime/runtime.js',
  'src/client/chart.js',
  'src/client/components.js',
  'src/client/app.js',
]

/** The vendored chart runtime, inlined into the page bundle only. */
const VENDOR = 'vendor/echarts.min.js'

/** The lazy loader the flattened modules reach the vendored runtime by. */
const VENDOR_GLOBAL = '__IUI_ECHARTS_LOAD'

/** The subset the sandboxed runner needs, in evaluation order. */
const RUNNER_MODULES = {
  catalog: 'lib/catalog.js',
  compile: 'lib/compile.js',
  composite: 'lib/composite.js',
  runtime: 'src/runtime/runtime.js',
}

/**
 * Turn one ES module into a fragment that can be concatenated into a single
 * function scope.
 *
 * The convention this enforces is deliberately narrow, because a narrow
 * convention is what makes it safe:
 *
 *   * every `import` is a single line with no side effects, and is dropped —
 *     the imported names are simply in scope after flattening;
 *   * `export const|let|var|function|class` loses the keyword;
 *   * a trailing `export { … }` re-export list is dropped;
 *   * no module uses `export default`, and no module relies on its own name.
 *
 * Top-level names must therefore be unique across the set. `client.js` asserts
 * that after generating, so a collision fails the build instead of producing a
 * bundle that silently misbehaves in the browser.
 */
function flatten(source, file) {
  if (/^\s*export\s+default\b/m.test(source)) {
    throw new Error(`${file}: "export default" is not supported by the flattener`)
  }
  return source
    .replace(/^[ \t]*import\b[^\n]*\n/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*\n/gm, '')
    .replace(/^[ \t]*export\s+(?=(const|let|var|function|class|async)\b)/gm, '')
}

async function readFlattened(relative) {
  const source = await readFile(path.join(root, relative), 'utf8')
  return flatten(source, relative)
}

/** Collect every top-level declaration name, so collisions fail the build. */
function topLevelNames(fragment, file) {
  const names = []
  const pattern = /^(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
  let match
  while ((match = pattern.exec(fragment)) !== null) names.push({ name: match[1], file })
  return names
}

function assertNoCollisions(entries) {
  const seen = new Map()
  const clashes = []
  for (const [file, fragment] of entries) {
    for (const { name } of topLevelNames(fragment, file)) {
      const previous = seen.get(name)
      if (previous !== undefined && previous !== file) clashes.push(`${name} (${previous} ↔ ${file})`)
      else seen.set(name, file)
    }
  }
  if (clashes.length > 0) {
    throw new Error(`top-level name collisions across modules:\n  ${clashes.join('\n  ')}`)
  }
  return seen.size
}

/**
 * Wrap a UMD distribution so it can live inside the bundle's module scope.
 *
 * Two problems, one wrapper:
 *
 *   * the vendored file is a UMD bundle that would otherwise attach itself to
 *     this bundle's own `module.exports`, so it gets a private pair instead;
 *   * its module body reads `navigator` and builds its own registries, which
 *     costs work on every page load even when no card draws a chart — so the
 *     body sits inside a function and runs at the first chart instead.
 *
 * `typeof __IUI_ECHARTS_LOAD` is therefore the presence test the renderer uses,
 * and it stays false under Node, where the renderer falls back to inline SVG.
 */
async function readVendor() {
  const body = await readFile(path.join(root, VENDOR), 'utf8')
  const wrapped = [
    'var __IUI_ECHARTS_CACHE = null',
    `function ${VENDOR_GLOBAL}() {`,
    '  if (__IUI_ECHARTS_CACHE !== null) return __IUI_ECHARTS_CACHE',
    '  var module = { exports: {} }',
    '  var exports = module.exports',
    body,
    '  __IUI_ECHARTS_CACHE = module.exports',
    '  return __IUI_ECHARTS_CACHE',
    '}',
  ].join('\n')
  new vm.Script(wrapped, { filename: VENDOR })
  return wrapped
}

async function main() {
  const fragments = []
  for (const relative of PAGE_MODULES) fragments.push([relative, await readFlattened(relative)])

  const declarationCount = assertNoCollisions(fragments)
  const clashesWithVendor = fragments
    .filter(([, fragment]) => topLevelNames(fragment).some(({ name }) => name === VENDOR_GLOBAL))
    .map(([file]) => file)
  if (clashesWithVendor.length > 0) {
    throw new Error(`${VENDOR_GLOBAL} is declared by ${clashesWithVendor.join(', ')}`)
  }
  const vendor = await readVendor()

  // The runner is the same code, plus the lockdown, assembled as text.
  const runnerParts = {}
  for (const [key, relative] of Object.entries(RUNNER_MODULES)) {
    runnerParts[key] = fragments.find(([file]) => file === relative)[1]
  }
  runnerParts.lockdown = lockdownSource()
  const runner = workerSource(runnerParts)

  // A syntax bug would be swapped into a live page by HMR and take the plugin
  // down, so the whole bundle is parsed before it reaches disk.
  const body = [vendor, ...fragments.map(([, fragment]) => fragment)].join('\n;\n')
  new vm.Script(body, { filename: 'client-body.js' })

  const bundle = `/**
 * Intelligent UI — browser half. GENERATED by scripts/build-client.mjs; do not edit.
 *
 * ${declarationCount} top-level declarations from ${PAGE_MODULES.length} modules, flattened into one scope,
 * behind the vendored Apache ECharts runtime (${VENDOR}).
 * The runner source below is the same code plus the sandbox lockdown, shipped as
 * text so the page can start it from a Blob URL in a Worker.
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

${body}

    var INTELLIGENT_UI_FACTORY_SOURCE = ${JSON.stringify(runner)}
    var __plugin = createClientPlugin({
      React: require('react'),
      sources: { runner: INTELLIGENT_UI_FACTORY_SOURCE },
    })
    exports.apply = __plugin.apply
    exports.inject = __plugin.inject
    exports.runnerSource = INTELLIGENT_UI_FACTORY_SOURCE
    exports.PLUGIN_NAME = PLUGIN_NAME
    return module.exports
  },
});
`

  new vm.Script(bundle, { filename: 'client.js' })
  const out = path.join(root, 'client.js')
  await writeFile(out, bundle, 'utf8')

  const bytes = Buffer.byteLength(bundle)
  const vendorBytes = Buffer.byteLength(vendor)
  process.stdout.write(`client.js  ${bytes} bytes  (${(bytes / 1024).toFixed(1)} KiB)\n`)
  process.stdout.write(`  of which ECharts ${(vendorBytes / 1024).toFixed(1)} KiB\n`)
  process.stdout.write(`runner     ${Buffer.byteLength(runner)} bytes, ${Object.keys(RUNNER_MODULES).length + 2} modules flattened (sandbox has no chart runtime)\n`)
}

main().catch((error) => {
  process.stderr.write(`build failed: ${error.stack ?? error}\n`)
  process.exitCode = 1
})
