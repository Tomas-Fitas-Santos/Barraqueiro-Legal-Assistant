'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';

import { HelpNav } from '@/components/help/help-nav';
import { HelpSymbol, HelpTopicSection } from '@/components/help/help-topics';
import { PageHeader } from '@/components/ui/page';
import { HELP_CONTEXTS, HELP_SECTIONS, type HelpContextId, type HelpSection } from '@/lib/help-contexts';

const SCROLLER_ID = 'help-scroll';

function topicTop(scroller: HTMLElement, topic: HTMLElement) {
  return scroller.scrollTop + topic.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

function groupSections(sections: readonly HelpSection[]) {
  return sections.reduce<Array<{ group: HelpSection['group']; topics: HelpSection[] }>>((groups, topic) => {
    const current = groups.at(-1);
    if (current?.group === topic.group) current.topics.push(topic);
    else groups.push({ group: topic.group, topics: [topic] });
    return groups;
  }, []);
}

export function HelpView({ context = '', returnTo = '' }: { context?: string; returnTo?: string }) {
  const definition = context in HELP_CONTEXTS ? HELP_CONTEXTS[context as HelpContextId] : null;
  const highlightedId = definition?.section || '';

  useEffect(() => {
    if (!highlightedId) return;
    const scroller = document.getElementById(SCROLLER_ID);
    const section = document.getElementById(highlightedId);
    if (!scroller || !section) return;
    scroller.scrollTo({ top: topicTop(scroller, section), behavior: 'auto' });
  }, [highlightedId]);

  const chapters = groupSections(HELP_SECTIONS);

  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <PageHeader title="Ajuda" description="Siga as instruções passo a passo para a Biblioteca, o Resumo documental ou a Revisão / Atualização." actions={returnTo.startsWith('/') ? <Link href={returnTo as Route} className="ui-btn-secondary inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-base no-underline"><ArrowLeft aria-hidden className="h-4 w-4" /> Voltar ao trabalho</Link> : undefined} />
    {definition ? <div className="mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-accent bg-accent-ghost px-4 py-2.5 text-sm text-ink1"><HelpSymbol /><span>Instrução aberta: <strong className="text-ink0">{definition.label}</strong></span></div> : null}
    <div className="grid min-h-0 flex-1 grid-rows-[13rem_minmax(0,1fr)] gap-4 overflow-hidden md:grid-cols-[20rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <HelpNav sections={HELP_SECTIONS} scrollerId={SCROLLER_ID} />
      <div id={SCROLLER_ID} className="min-h-0 overflow-y-auto overscroll-contain rounded-xl pr-1" tabIndex={0} aria-label="Conteúdo da Ajuda">
        <div className="flex flex-col gap-8 pb-2">
          {chapters.map(({ group, topics }) => <section key={group} aria-label={group}>
            <div className="mb-3 flex items-center gap-3">
              <h2 className="m-0 whitespace-nowrap font-heading text-lg font-semibold text-ink0">{group}</h2>
              <span aria-hidden className="h-px flex-1 bg-line1" />
            </div>
            <div className="flex flex-col gap-4">
              {topics.map((topic) => <HelpTopicSection key={topic.id} sectionId={topic.id} highlighted={highlightedId === topic.id} showGroup={false} />)}
            </div>
          </section>)}
        </div>
      </div>
    </div>
  </div>;
}
