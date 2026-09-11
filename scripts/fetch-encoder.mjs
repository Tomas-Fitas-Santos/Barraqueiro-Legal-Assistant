// Downloads the local encoder's weights into the image at build time. Run by the
// Dockerfile; harmless to run locally.
const dir = process.env.LEGAL_MODELS_DIR || './models';
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = dir;
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
// Encode once: a model that downloads but cannot run is a build that must fail here rather
// than at the first ingest in production.
const out = await extractor(['passage: verificação'], { pooling: 'mean', normalize: true });
console.log(`encoder ready in ${dir} (${Date.now() - t0} ms, dims ${out.dims.join('x')})`);
