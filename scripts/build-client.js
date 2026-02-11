import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [path.join(root, 'src', 'client.js')],
  bundle: true,
  outfile: path.join(root, 'public', 'js', 'bundle.js'),
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
  },
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('[Build] Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('[Build] Client bundle built successfully');
}
