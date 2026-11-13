import * as esbuild from 'esbuild';

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

const configs = args.has('--tests')
  ? [
      {
        ...common,
        entryPoints: ['test/parser.test.ts', 'test/export.test.ts', 'test/introspect.test.ts', 'test/ops.test.ts'],
        outdir: 'dist-test',
        external: ['pg-native', 'cloudflare:sockets'],
        platform: 'node',
        format: 'cjs',
        target: 'node20',
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        // vscode is provided by the host; pg-native and friends are optional native add-ons.
        external: ['vscode', 'pg-native', 'cloudflare:sockets'],
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

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
