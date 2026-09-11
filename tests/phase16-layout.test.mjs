import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { api, BASE, loadTsModule, loginAdmin, startServer, stopServer, testDataDir } from './helpers.mjs';

// §7.5 — reading a page's shape.
//
// The geometry rules are unit-tested against hand-built runs rather than against a PDF,
// because a PDF fixture cannot isolate "what happens when two lines agree on where their
// columns start" from forty other things happening on the same page. The end-to-end test
// then proves the same rules survive the real pipeline on the client's own document.
//
// The one with teeth is the boilerplate test. A footer repeated on every page is not a
// cosmetic problem: it is identical across a document AND similar across every document
// from the same company, so leaving it in the segments inflates the measured similarity
// between documents that have nothing to do with each other — the exact signal phase 9's
// semantic index is about to be built on.

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');
let layout;

/** One line of runs at a given y, laid out left to right. */
function line(y, fontSize, pieces) {
  let x = pieces[0].x ?? 56;
  return pieces.map((piece) => {
    const width = piece.width ?? piece.str.length * fontSize * 0.5;
    const item = { str: piece.str, x: piece.x ?? x, y, width, height: fontSize, fontSize };
    x = item.x + width;
    return item;
  });
}

describe('phase 16 — the shape of a page', () => {
  before(async () => {
    layout = await loadTsModule('src/lib/server/ingest/layout.ts');
  });

  it('groups runs into lines by where they sit, not by the order they were written', () => {
    const items = [
      ...line(700, 11, [{ str: 'segunda', x: 200 }]),
      ...line(720, 11, [{ str: 'primeira', x: 56 }]),
      // A run a hair off the baseline is still the same line.
      { str: 'linha', x: 120, y: 719.6, width: 25, height: 11, fontSize: 11 },
    ];
    const lines = layout.buildLines(items);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].text, 'primeira linha');
    assert.equal(lines[1].text, 'segunda');
  });

  it('promotes a heading by its size and leaves legal enumerations as the text they are', () => {
    const items = [
      ...line(760, 20, [{ str: 'CÓDIGO DE CONDUTA' }]),
      ...line(730, 14, [{ str: 'Capítulo I' }]),
      ...line(700, 10, [{ str: '3. O trabalhador deve observar as regras seguintes:' }]),
      ...line(680, 10, [{ str: 'a) agir com lealdade;' }]),
      ...line(660, 10, [{ str: '• dever de sigilo' }]),
      ...line(640, 10, [{ str: '• dever de zelo' }]),
    ];
    const page = layout.renderPage(layout.buildLines(items));
    const blocks = page.text.split('\n');
    assert.equal(blocks[0], '# CÓDIGO DE CONDUTA');
    assert.equal(blocks[2], '## Capítulo I');
    assert.equal(page.headings, 2);
    // "3." and "a)" are how a Portuguese legal document NUMBERS itself. Rewriting them as
    // Markdown bullets would destroy the reference a citation is made against.
    assert.ok(page.text.includes('3. O trabalhador deve observar as regras seguintes:'));
    assert.ok(page.text.includes('a) agir com lealdade;'));
    // A bullet glyph carries no such meaning, so it becomes a list.
    assert.ok(page.text.includes('- dever de sigilo\n- dever de zelo'), page.text);
    assert.equal(page.lists, 2);
  });

  it('reads a table only when consecutive rows agree on their columns, and says so quietly', () => {
    const rows = [
      ...line(700, 10, [
        { str: 'Cargo', x: 56, width: 40 },
        { str: 'Nível', x: 300, width: 40 },
      ]),
      ...line(685, 10, [
        { str: 'Motorista', x: 56, width: 60 },
        { str: 'III', x: 300, width: 20 },
      ]),
      ...line(670, 10, [
        { str: 'Mecânico', x: 56, width: 60 },
        { str: 'IV', x: 300, width: 20 },
      ]),
    ];
    const page = layout.renderPage(layout.buildLines(rows));
    assert.ok(page.text.includes('| Cargo | Nível |'), page.text);
    assert.ok(page.text.includes('| --- | --- |'));
    assert.ok(page.text.includes('| Motorista | III |'));
    assert.equal(page.tables, 1);

    // One line with two columns is a label and a value, not a table.
    const single = layout.renderPage(
      layout.buildLines(
        line(700, 10, [
          { str: 'Data', x: 56, width: 30 },
          { str: '6 de março de 2026', x: 300, width: 90 },
        ]),
      ),
    );
    assert.equal(single.tables, 0);
    assert.equal(single.text, 'Data 6 de março de 2026');
  });

  it('drops what repeats at the edges of most pages, and keeps what repeats in the body', () => {
    const page = (n) => [
      ...line(780, 9, [{ str: 'Grupo Barraqueiro — Documento interno' }]),
      ...line(700, 10, [{ str: 'O incumprimento é sancionado nos termos do presente código.' }]),
      ...line(60, 9, [{ str: `- ${n} -` }]),
    ];
    const stripped = layout.stripBoilerplate([1, 2, 3, 4, 5].map((n) => layout.buildLines(page(n))));
    for (const lines of stripped) {
      assert.deepEqual(
        lines.map((l) => l.text),
        ['O incumprimento é sancionado nos termos do presente código.'],
        'the running head and the page number go; the clause stays',
      );
    }

    // Under three pages there is no such thing as "repeats on most pages".
    const short = layout.stripBoilerplate([1, 2].map((n) => layout.buildLines(page(n))));
    assert.equal(short[0].length, 3);
  });

  it('rejoins a wrapped line into its paragraph, and ends the paragraph where the text does', () => {
    // Two full-width lines, then one that stops well short: one paragraph. Then another.
    const items = [
      ...line(700, 10, [{ str: 'O presente documento estabelece as regras aplicáveis a', x: 56, width: 400 }]),
      ...line(686, 10, [{ str: 'todos os colaboradores do Grupo.', x: 56, width: 200 }]),
      ...line(660, 10, [{ str: 'Um segundo parágrafo, com a mesma largura de coluna que', x: 56, width: 400 }]),
    ];
    const page = layout.renderPage(layout.buildLines(items));
    assert.equal(
      page.text,
      'O presente documento estabelece as regras aplicáveis a todos os colaboradores do Grupo.\n\nUm segundo parágrafo, com a mesma largura de coluna que',
    );
  });

  it('rejoins a hyphen-broken line without inventing or destroying a character', () => {
    const items = [
      ...line(700, 10, [{ str: 'consultar em https://eur-lex.europa.eu/legal-', x: 56, width: 400 }]),
      ...line(686, 10, [{ str: 'content/PT/ALL/?uri=CELEX:32023L0970', x: 56, width: 200 }]),
    ];
    const page = layout.renderPage(layout.buildLines(items));
    assert.ok(page.text.includes('https://eur-lex.europa.eu/legal-content/PT/ALL/?uri=CELEX:32023L0970'), page.text);
  });
});

describe('phase 16 — the same rules through the real pipeline', () => {
  let jar;
  before(async () => {
    await startServer({ env: { LEGAL_FAKE_GRAPH: '' } });
    jar = await loginAdmin();
  });
  after(async () => {
    await stopServer();
  });

  it('the client’s own nota comes out structured, de-repeated and in paragraphs', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(testDataDir(), 'legal-assistant.sqlite'));
    const now = Date.now();
    db.prepare(
      `INSERT INTO documents (document_id, drive_item_id, name, path, mime, size, state, removed, synced_at, created_at, updated_at)
       VALUES ('doc_layout', 'local-doc_layout', 'Nota Interna Transparência Salarial.pdf', '', 'application/pdf', 0, 'listed', 0, ?, ?, ?)`,
    ).run(now, now, now);
    db.close();

    const res = await fetch(`${BASE}/api/library/documents/doc_layout/original`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        cookie: [...jar.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: readFileSync(path.join(FIXTURES, 'nota-interna-transparencia-salarial.pdf')),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.json()));

    const { data } = await api('/api/library/documents/doc_layout', { jar });
    assert.equal(data.ok, true, JSON.stringify(data));

    assert.ok(data.pages[0].text.startsWith('## NOTA INTERNA'), data.pages[0].text.slice(0, 80));
    assert.ok(data.document.structure.headings > 0);

    // "- 1 -", "- 2 -" … is on every page of this document and must be on none of them now.
    for (const page of data.pages) {
      assert.ok(!/^- \d+ -$/m.test(page.text), `page ${page.page} still carries its footer`);
    }

    // Paragraphs, not one line per visual line: the longest paragraph has to be longer than
    // any single printed line could be.
    const longest = Math.max(...data.pages[0].text.split('\n\n').map((p) => p.length));
    assert.ok(longest > 400, `expected wrapped lines to be rejoined, longest paragraph was ${longest}`);

    // …and that is what the segmenter splits on, so the page is several citable segments.
    process.env.LEGAL_DATA_DIR = testDataDir();
    const { searchSegments } = await loadTsModule('src/lib/server/ingest/pages.ts');
    assert.ok(searchSegments('transparência').length > 0, 'the structured text is still indexed');
  });
});
