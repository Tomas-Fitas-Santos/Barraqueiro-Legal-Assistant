'use client';

import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { HelpSection } from '@/lib/help-contexts';

export function HelpNav({ sections, scrollerId }: { sections: readonly HelpSection[]; scrollerId: string }) {
  const [active, setActive] = useState(sections[0]?.id || '');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const scroller = document.getElementById(scrollerId);
    if (!scroller) return;
    const sync = () => {
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (atBottom) { setActive(sections[sections.length - 1]?.id || ''); return; }
      const top = scroller.getBoundingClientRect().top;
      // Read a little way into the pane. A topic whose last few pixels remain above the
      // next card is no longer the topic the person is actually reading.
      const readingLine = top + Math.min(80, scroller.clientHeight * 0.15);
      let current = sections[0]?.id || '';
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= readingLine) current = section.id;
      }
      setActive(current);
    };
    sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    return () => scroller.removeEventListener('scroll', sync);
  }, [sections, scrollerId]);

  const grouped = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('pt-PT');
    const visible = normalized ? sections.filter((section) => `${section.label} ${section.group}`.toLocaleLowerCase('pt-PT').includes(normalized)) : [...sections];
    return visible.reduce<Array<{ group: HelpSection['group']; topics: HelpSection[] }>>((groups, topic) => {
      const existing = groups.find((entry) => entry.group === topic.group);
      if (existing) existing.topics.push(topic); else groups.push({ group: topic.group, topics: [topic] });
      return groups;
    }, []);
  }, [query, sections]);

  const openTopic = (id: string) => {
    const scroller = document.getElementById(scrollerId);
    const topic = document.getElementById(id);
    if (!scroller || !topic) return;
    const top = scroller.scrollTop + topic.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top, behavior: 'auto' });
    setActive(id);
  };

  return <aside className="ui-panel grid min-h-0 h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl p-3">
    <div className="pb-3">
      <label className="relative block"><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 ui-text-muted" /><span className="sr-only">Pesquisar na Ajuda</span><input value={query} onChange={(event) => setQuery(event.target.value)} className="ui-input h-9 pl-9 text-sm" placeholder="Pesquisar tópicos" /></label>
    </div>
    <nav className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain pr-1" aria-label="Índice da Ajuda">
      {grouped.length ? grouped.map(({ group, topics }) => <section key={group} className="rounded-lg border border-line0 bg-surface-soft p-2"><h2 className="m-0 mb-1.5 px-1.5 text-xs font-semibold uppercase tracking-wide text-ink1">{group}</h2><ul className="m-0 flex list-none flex-col gap-0.5 p-0">{topics.map((topic) => <li key={topic.id}><button type="button" onClick={() => openTopic(topic.id)} aria-current={active === topic.id ? 'true' : undefined} className={`block w-full rounded-md border-0 px-2.5 py-1.5 text-left text-sm ${active === topic.id ? 'bg-accent-soft font-medium text-accent-strong' : 'bg-transparent text-ink1 hover:bg-surface'}`}>{topic.label}</button></li>)}</ul></section>) : <p className="m-2 text-sm ui-text-muted">Nenhum tópico encontrado.</p>}
    </nav>
  </aside>;
}
