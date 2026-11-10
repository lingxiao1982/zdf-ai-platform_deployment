/**
 * Node ESM loader: transform src/*.jsx with esbuild so node --test can import App.jsx.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.includes('/src/') || !url.endsWith('.jsx')) {
    return nextLoad(url, context);
  }
  const filePath = fileURLToPath(url);
  const source = readFileSync(filePath, 'utf8');
  const result = esbuild.transformSync(source, {
    loader: 'jsx',
    format: 'esm',
    jsx: 'automatic',
    sourcefile: filePath,
    define: {
      'import.meta.env.BASE_URL': JSON.stringify('/'),
      'import.meta.env.MODE': JSON.stringify('test'),
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
    },
  });
  return { format: 'module', source: result.code, shortCircuit: true };
}
