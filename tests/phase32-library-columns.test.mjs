import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// The Library listing showed every template and every generated file as "—" under Tipo and
// as "Template"/"Documento gerado" under Estado: the kind was rendering in the state column
// and the type column had nothing to say, because only an official document is classified.
//
// The type of an app-owned file is not a judgement, it is what the file is. The state is the
// one question each kind can actually answer: has the model been customised, was the output
// approved.

async function openDb() {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
}

async function listAll(jar) {
  const res = await api('/api/library/list?recursive=1&limit=300', { jar });
  return res.data.files || [];
}

describe('phase32 — what the Tipo and Estado columns say about the app’s own files', () => {
  let jar;

  before(async () => {
    await startServer();
    jar = await loginAdmin();
    // Templates only reach the Library once there is a folder to publish them into.
    await api('/api/msgraph/folder', {
      method: 'POST',
      body: { folderId: 'fake-root', folderName: 'fake-onedrive' },
      jar,
    });
    await api('/api/library/sync', { method: 'POST', jar });
  });

  after(async () => {
    await stopServer();
  });

  it('names each template and each generated file by what it IS', async () => {
    const {
      TEMPLATE_FILE_PURPOSES,
      analysisTypeForTemplatePath,
      ownedFileTypeLabel,
      templateFileKind,
    } = await loadTsModule('src/lib/library-layout.ts');

    // A template folder holds one template of each kind; the row names the exact purpose.
    assert.equal(ownedFileTypeLabel('template', 'nota-resumo.docx'), 'Template de documento');
    assert.equal(ownedFileTypeLabel('template', 'email-resumo.eml'), 'Template de e-mail');
    assert.equal(ownedFileTypeLabel('template', 'dados-resumo.json'), 'Template de campos');
    assert.equal(templateFileKind('modelo-novo.docx'), 'docx');
    assert.equal(templateFileKind('entrega.eml'), 'eml');
    assert.equal(templateFileKind('campos.json'), 'json');
    assert.match(TEMPLATE_FILE_PURPOSES.docx.purpose, /documento Word/);
    assert.match(TEMPLATE_FILE_PURPOSES.eml.purpose, /assunto/);
    assert.match(TEMPLATE_FILE_PURPOSES.json.purpose, /campos estruturados/);
    // The extension says what the template does; its subfolder says which workflow uses it.
    assert.equal(analysisTypeForTemplatePath('2. Templates/Resumo documental/modelo-novo.docx'), 'summary');
    assert.equal(analysisTypeForTemplatePath('2. Templates/Revisão e Atualização/modelo-novo.docx'), 'revision');
    assert.equal(analysisTypeForTemplatePath('2. Templates/modelo-sem-fluxo.docx'), null);

    assert.equal(ownedFileTypeLabel('generated', 'Nota_X_v1a.docx'), 'Documento gerado');
    assert.equal(ownedFileTypeLabel('generated', 'Nota_X_v1a_final.pdf'), 'PDF final');
    assert.equal(ownedFileTypeLabel('generated', 'Nota_X_v1a_dados.json'), 'Dados extraídos');

    // An official document keeps the model's classification, so this must stay out of the way.
    assert.equal(ownedFileTypeLabel('official', 'PPRC.pdf'), '');
  });

  it('reports a template as Original until it is edited, then as Editado', async () => {
    const before = (await listAll(jar)).find((f) => f.name === 'nota-resumo.docx');
    assert.ok(before, 'the built-in template is not in the library');
    assert.equal(before.documentKind, 'template');
    assert.equal(before.templateEdited, false);

    const current = await api('/api/templates/nota_resumo/blocks', { jar });
    const blocks = current.data.blocks;
    blocks[0].text = `${blocks[0].text || ''} `;
    const saved = await api('/api/templates/nota_resumo/blocks', { method: 'PUT', body: { blocks }, jar });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));

    const after = (await listAll(jar)).find((f) => f.name === 'nota-resumo.docx');
    assert.equal(after.templateEdited, true, 'a saved template still reports as Original');

    // And reverting puts it back — the column tracks the state, it does not latch.
    await api('/api/templates/nota_resumo/blocks', { method: 'DELETE', jar });
    const reverted = (await listAll(jar)).find((f) => f.name === 'nota-resumo.docx');
    assert.equal(reverted.templateEdited, false, 'Repor original left the template marked as edited');
  });

  it('carries a generated file’s approval state, and invents none for the data record', async () => {
    const db = await openDb();
    const now = Date.now();
    // Two outputs of one conversion — the document and its PDF — plus the extraction record,
    // which no conversion covers and nobody approved.
    const rows = [
      ['doc_gen_docx', 'item-docx', 'Nota_T_v1a.docx'],
      ['doc_gen_pdf', 'item-pdf', 'Nota_T_v1a_final.pdf'],
      ['doc_gen_json', 'item-json', 'Nota_T_v1a_dados.json'],
    ];
    for (const [id, item, name] of rows) {
      db.prepare(
        `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', 0, 'indexed', ?, ?)`,
      ).run(id, item, name, '3. Documentos gerados/Resumo documental/Resumo — T', now, now);
    }
    db.prepare(
      `INSERT INTO conversions (conversion_id, analysis_id, version_id, docx_sha256, onedrive_docx_id,
                                onedrive_pdf_id, state, created_at, updated_at)
       VALUES ('cnv_t', 'ana_t', 'ver_t', 'sha', 'item-docx', 'item-pdf', 'aprovado_para_envio', ?, ?)`,
    ).run(now, now);
    db.close();

    const files = await listAll(jar);
    const byName = (name) => files.find((f) => f.name === name);

    assert.equal(byName('Nota_T_v1a.docx').outputState, 'aprovado_para_envio');
    assert.equal(byName('Nota_T_v1a_final.pdf').outputState, 'aprovado_para_envio');
    // The record sits beside two approved files and must not borrow their state.
    assert.equal(byName('Nota_T_v1a_dados.json').outputState, '');

    const { GENERATED_STATE_LABELS } = await loadTsModule('src/lib/types.ts');
    assert.equal(GENERATED_STATE_LABELS.aprovado_para_envio, 'Aprovado');
    assert.equal(GENERATED_STATE_LABELS.pronto_para_revisao, 'Por aprovar');
  });
});
