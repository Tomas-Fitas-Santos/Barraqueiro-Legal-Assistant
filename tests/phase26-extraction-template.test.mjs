import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// Workstream D3 — the template drives the extraction.
//
// The shape of an extraction lived in three places that had to agree by hand: the AI schema,
// the validators and the review screen's field list. Adding a field meant editing all three
// and shipping. The template is now the source of the CONTENT fields — and only those: the
// citation spine is §10/§11 and stays where the validators can rely on it.

const FIELDS_URL = '/api/templates/dados_resumo/fields';

async function authedFetch(jar, p, init = {}) {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
  });
}

async function put(jar, fields) {
  const res = await authedFetch(jar, FIELDS_URL, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return { status: res.status, body: await res.json() };
}

let jar;
let shipped = [];

describe('workstream D3 — what the agent extracts is a template', () => {
  before(async () => {
    await startServer();
    jar = await loginAdmin();
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });
    shipped = (await api(FIELDS_URL, { jar })).data.fields;
  });
  after(async () => {
    await stopServer();
  });

  it('ships the §10 field list, registered and published as its own kind', async () => {
    assert.deepEqual(
      shipped.map((f) => f.key),
      ['topic', 'scope', 'content', 'entity', 'required_action', 'suggested_owner', 'deadline', 'consequence', 'exceptions'],
      'the shipped extraction template is no longer the §10 list',
    );

    const rows = (await api('/api/templates', { jar })).data.templates.filter((t) => t.active && t.kind === 'json');
    assert.deepEqual(rows.map((t) => t.templateId).sort(), ['dados_resumo', 'dados_revisao']);

    const published = JSON.parse(
      readFileSync(
        path.join(testDataDir(), 'fake-onedrive', '2. Templates', 'Resumo documental', 'dados-resumo.json'),
        'utf8',
      ),
    );
    assert.equal(published.schema, 'legal-assistant/extraction-template@1');
    assert.equal(published.fields.length, shipped.length);
    // The published file says out loud that the grounding contract is not negotiable.
    assert.match(published.grounding.note, /not_confirmed/);
    assert.ok(published.grounding.fixedFields.includes('source_excerpt'));
  });

  it('generates the AI schema from the fields, spine included', async () => {
    const { summaryExtractionSchema, revisionMatrixSchema } = await loadTsModule('src/lib/server/ai/schemas.ts');
    const schema = summaryExtractionSchema([
      { key: 'topic', label: 'Tema', description: 'o tema' },
      { key: 'clausula', label: 'Cláusula', description: 'o número da cláusula' },
    ]);
    const item = schema.properties.statements.items;
    // The field the client asked for is in the schema, carrying its description as the
    // instruction the model receives.
    assert.equal(item.properties.clausula.description, 'o número da cláusula');
    assert.ok(item.required.includes('clausula'));
    // And the spine came along, un-asked-for and unremovable.
    for (const key of ['source_document_id', 'source_page', 'source_excerpt', 'evidence_quality', 'ai_suggestion']) {
      assert.ok(item.properties[key], `${key} is missing from the generated schema`);
      assert.ok(item.required.includes(key));
    }
    assert.equal(item.additionalProperties, false);
    // A field the app never heard of cannot appear at all.
    assert.ok(!item.properties.inventado);

    const matrix = revisionMatrixSchema([{ key: 'topic', label: 'Tema', description: 'o tema' }]);
    assert.ok(matrix.properties.lines.items.properties.relationship_type.enum.includes('substitui'));
  });

  it('accepts a new field and remembers it', async () => {
    const next = [...shipped, { key: 'clausula', label: 'Cláusula', description: 'O número da cláusula onde consta.' }];
    const saved = await put(jar, next);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = await api(FIELDS_URL, { jar });
    assert.equal(after.data.edited, true);
    assert.deepEqual(after.data.fields.at(-1).key, 'clausula');

    // The published .json follows, and the registry mints a version by the same route a
    // replaced file would.
    const published = JSON.parse(
      readFileSync(
        path.join(testDataDir(), 'fake-onedrive', '2. Templates', 'Resumo documental', 'dados-resumo.json'),
        'utf8',
      ),
    );
    assert.ok(published.fields.some((f) => f.key === 'clausula'));
    const row = (await api('/api/templates', { jar })).data.templates.find(
      (t) => t.templateId === 'dados_resumo' && t.active,
    );
    assert.equal(row.version, 2);
  });

  it('refuses to let a field impersonate the citation', async () => {
    for (const key of ['source_page', 'evidence_quality', 'ai_suggestion']) {
      const res = await put(jar, [...shipped, { key, label: 'X', description: 'y' }]);
      assert.equal(res.status, 400, `${key} was accepted as a content field`);
      assert.match(res.body.error, /pertence à citação/);
    }
  });

  it('refuses to remove a field the code itself reads', async () => {
    // `deadline` is what §11 uses to demand a source for any deadline. Removing it would
    // silently weaken the validator rather than break anything visible.
    const res = await put(jar, shipped.filter((f) => f.key !== 'deadline'));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Data ou prazo/);
  });

  it('refuses a field it could not ask the agent for', async () => {
    const noDescription = await put(jar, [...shipped, { key: 'clausula', label: 'Cláusula', description: '  ' }]);
    assert.equal(noDescription.status, 400);
    assert.match(noDescription.body.error, /diz ao agente o que procurar/);

    const badKey = await put(jar, [...shipped, { key: 'Cláusula 3', label: 'X', description: 'y' }]);
    assert.equal(badKey.status, 400);
    assert.match(badKey.body.error, /não é um nome de campo válido/);

    const duplicate = await put(jar, [...shipped, { key: 'topic', label: 'X', description: 'y' }]);
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.error, /aparece duas vezes/);

    const empty = await put(jar, []);
    assert.equal(empty.status, 400);
  });

  it('offers the editor from the .json’s own library page', async () => {
    const list = await api('/api/library/list?recursive=1&limit=200', { jar });
    const file = (list.data.files || []).find((f) => f.name === 'dados-resumo.json');
    assert.ok(file, 'the extraction template is not in the library');
    const detail = await api(`/api/library/documents/${file.documentId}`, { jar });
    assert.equal(detail.data.editableTemplateId, 'dados_resumo');
  });

  it('puts the app’s own list back', async () => {
    const res = await authedFetch(jar, FIELDS_URL, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const state = await api(FIELDS_URL, { jar });
    assert.equal(state.data.edited, false);
    assert.deepEqual(state.data.fields.map((f) => f.key), shipped.map((f) => f.key));
  });

  it('an extraction keeps the fields it was made with', async () => {
    // The template may change afterwards; an extraction already approved must keep reading
    // as what it was, exactly as a document version keeps its template version.
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
    const cols = d.prepare('PRAGMA table_info(analysis_extractions)').all().map((c) => c.name);
    d.close();
    assert.ok(cols.includes('fields_json'), 'an extraction does not record the fields it was produced with');
  });
});
