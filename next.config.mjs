import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // The local encoder must not be bundled. onnxruntime-node resolves its native binding
  // through a RUNTIME require(path.join(__dirname,'bin',…)), which output tracing cannot
  // see — bundling it produces a build that is clean and then fails the first time anyone
  // encodes anything. Externalising it and naming the binaries explicitly is what keeps
  // them in the standalone output.
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node'],
  outputFileTracingIncludes: {
    '/**': ['./node_modules/onnxruntime-node/bin/napi-v6/**/*'],
  },
  typedRoutes: true,
  allowedDevOrigins: ['127.0.0.1'],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
