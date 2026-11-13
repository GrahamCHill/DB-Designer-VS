import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
};

/** Node bundles: PGlite reads import.meta.url, which a CommonJS bundle has to provide itself. */
const nodeCommon = {
  ...common,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'pg-native', 'cloudflare:sockets'],
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
};

/** The PGlite runtime used to execute exported PostgreSQL before saving it. */
function copyPgliteAssets() {
  const src = path.join('node_modules', '@electric-sql', 'pglite', 'dist');
  const dst = path.join('dist', 'pglite');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ['pglite.wasm', 'pglite.data', 'initdb.wasm', 'uuid-ossp.tar.gz', 'pgcrypto.tar.gz', 'citext.tar.gz'])
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
}

const configs = args.has('--tests')
  ? [
      {
        ...nodeCommon,
        entryPoints: [
          'test/parser.test.ts',
          'test/export.test.ts',
          'test/introspect.test.ts',
          'test/ops.test.ts',
          'test/sqlexport.test.ts',
          'test/validate.test.ts',
          'test/router.test.ts',
        ],
        outdir: 'dist-test',
      },
    ]
  : [
      {
        ...nodeCommon,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
      },
      {
        ...common,
        entryPoints: ['src/webview/main.tsx'],
        outfile: 'dist/webview.js',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
        loader: { '.css': 'css' },
        define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
      },
    ];

if (!args.has('--tests')) copyPgliteAssets();

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
