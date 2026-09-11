import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { loadTsModule } from './helpers.mjs';

describe('phase 33 — guidance is one product contract', () => {
  it('every contextual-help target exists in the guide', async () => {
    const help = await loadTsModule('src/lib/help-contexts.ts');
    const ids = new Set(help.HELP_SECTIONS.map((section) => section.id));
    for (const [context, definition] of Object.entries(help.HELP_CONTEXTS)) {
      assert.ok(ids.has(definition.section), `${context} points to missing section ${definition.section}`);
      assert.equal(help.helpHref(context).endsWith(`#${definition.section}`), true);
    }

    const topics = readFileSync('src/components/help/help-topics.tsx', 'utf8');
    const view = readFileSync('src/components/help/help-view.tsx', 'utf8');
    assert.match(view, /groupSections\(HELP_SECTIONS\)/);
    assert.match(view, /topics\.map[\s\S]*HelpTopicSection/);
    assert.match(view, /topicTop\(scroller, section\)/);
    assert.match(topics, /<HelpTopicBody sectionId=/);
    for (const id of ids) assert.match(topics, new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));

    const groups = help.HELP_SECTIONS.map((section) => section.group);
    const transitions = groups.filter((group, index) => index === 0 || group !== groups[index - 1]);
    assert.deepEqual(transitions, ['Começar', 'Preparar', 'Analisar', 'Aprovar', 'Consultar', 'Resolver']);
    assert.equal(new Set(transitions).size, transitions.length, 'each chapter must be one contiguous block');

    const nav = readFileSync('src/components/help/help-nav.tsx', 'utf8');
    assert.match(nav, /readingLine/);
    assert.match(nav, /behavior: 'auto'/);
    assert.match(nav, /rounded-lg border border-line0 bg-surface-soft/);
  });

  it('uses a complete, plain-language journey vocabulary', async () => {
    const language = await loadTsModule('src/lib/product-language.ts', {
      'src/lib/types.ts': 'src/lib/types.ts',
      'src/lib/workflow/phases.ts': 'src/lib/workflow/phases.ts',
    });
    assert.deepEqual(Object.keys(language.WORK_BUCKET_LABELS), ['waiting_user', 'working', 'concluded']);
    assert.deepEqual(Object.keys(language.ANALYSIS_JOURNEY_LABELS), [
      'configuracao', 'extracao', 'revisao', 'documento', 'pdf', 'email',
    ]);
    assert.equal(language.VERSION_LANGUAGE.section, 'Versões e histórico');
    assert.match(language.FINDING_STATUS_LABELS.validation_rejected, /Excluído/);
  });
});
