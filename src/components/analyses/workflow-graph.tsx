'use client';

// The workflow as a readable timeline: one lane per path, and inside each lane the nodes
// that actually happened, in order, joined by edges that SAY what happened between them
// ("avança para Documento", "nova versão", "ramifica de v1a"). A phase can hold several
// nodes — each generated document is its own node, so are chat changes and conversions.

import { EVENTS, eventNodeTitle, eventPhase, isEventKind } from '@/lib/workflow';

export type GraphFeedEntry = {
  at: number;
  kind: string;
  /** Stamped by the server at write time — never inferred from timestamps here. */
  pathLetter: string;
  data: Record<string, unknown>;
};

export type GraphPath = {
  letter: string;
  parentVersionId: string;
  parentLabel: string;
  /** The stage the fork restarted from: where the branch leaves its parent path. */
  parentStage: string;
  createdAt?: number;
};

export type StageMeta = { key: string; label: string };

export type GraphNode = {
  id: string;
  pathLetter: string;
  stageKey: string;
  stageLabel: string;
  /**
   * What the card shows above the title, when it is not simply the phase. An empty string
   * means show nothing: the closing card's title already says the analysis ended, and
   * badging it "E-MAIL" made the end of the work read as one more mail step. The phase
   * itself stays on `stageKey`, which is what groups lanes, draws edges and decides
   * whether a node can be reverted to.
   */
  badge?: string;
  /** What this node is, in the user's words. */
  title: string;
  /** Optional short qualifier (version label, counts…). */
  detail: string;
  /** What the step INTO this node was. */
  edgeLabel: string;
  entries: GraphFeedEntry[];
  at: number;
};

export const PATH_TONES = ['ui-pill-accent', 'ui-pill-ok', 'ui-pill-info', 'ui-pill-warn'];

export function toneOf(letter: string): string {
  return PATH_TONES[Math.max(0, letter.charCodeAt(0) - 97) % PATH_TONES.length];
}

/**
 * A path's LINEAGE: itself plus everything its ancestors did up to the moment it branched
 * off. This is what "show me only this path" means — path B is A-until-the-fork plus B.
 */
export function pathLineage(
  feed: GraphFeedEntry[],
  paths: GraphPath[],
  letter: string,
): Array<{ letter: string; until: number }> {
  const byLetter = new Map(paths.map((p) => [p.letter, p]));
  const versionPath = new Map<string, { letter: string; at: number }>();
  for (const entry of feed) {
    if (entry.kind === 'version') {
      versionPath.set(String(entry.data.versionId), { letter: String(entry.data.pathLetter || 'a'), at: entry.at });
    }
  }
  const chain: Array<{ letter: string; until: number }> = [{ letter, until: Number.MAX_SAFE_INTEGER }];
  let current = byLetter.get(letter);
  while (current?.parentVersionId) {
    const parent = versionPath.get(current.parentVersionId);
    if (!parent) break;
    const forkAt = current.createdAt || parent.at;
    chain.push({ letter: parent.letter, until: forkAt });
    current = byLetter.get(parent.letter);
    if (chain.length > 26) break;
  }
  return chain;
}

export function isInLineage(entry: GraphFeedEntry, lineage: Array<{ letter: string; until: number }>): boolean {
  return lineage.some((step) => step.letter === entry.pathLetter && entry.at <= step.until);
}

/**
 * The chat's feed for a path: exactly the entries the graph puts in that path's lineage.
 * One rule, one place — the chat and the graph cannot drift apart.
 */
export function lineageFeed(feed: GraphFeedEntry[], paths: GraphPath[], letter: string): GraphFeedEntry[] {
  const lineage = pathLineage(feed, paths, letter);
  return feed.filter((entry) => isInLineage(entry, lineage));
}

/** The qualifier under a node's title — counts, labels, the reason for a recomeço. */
function nodeDetail(kind: string, data: Record<string, unknown>): string {
  const n = (key: string) => Number(data[key] || 0);
  const s = (key: string) => String(data[key] || '');
  switch (kind) {
    case 'relations_identified':
      return `${n('candidates')} candidato(s)`;
    case 'run_completed':
      return `${n('accepted')} itens${n('rejected') ? ` · ${n('rejected')} rejeitados` : ''}`;
    case 'extraction_approved':
      return s('label');
    case 'version_set_final':
      return s('label') || `v${n('versionNo')}`;
    case 'pdf_approved':
      return s('pdfName') || 'PDF final';
    case 'email_approved':
      return s('to') || s('pdfName');
    case 'tracked_back':
      return String(data.guidance || '')
        ? `“${String(data.guidance)}”`
        : `caminho ${String(data.newPath || '').toUpperCase()}`;
    case 'error':
      return String(data.message || '').slice(0, 60);
    default:
      return '';
  }
}

/** Build the ordered nodes of every path, each with what it is and how it was reached. */
export function buildGraph(feed: GraphFeedEntry[], paths: GraphPath[], stages: StageMeta[]): Map<string, GraphNode[]> {
  const stageLabel = new Map(stages.map((s) => [s.key, s.label]));
  const lanes = new Map<string, GraphNode[]>();
  for (const path of paths) lanes.set(path.letter, []);

  const push = (letter: string, node: Omit<GraphNode, 'id' | 'pathLetter' | 'edgeLabel' | 'stageLabel'>) => {
    const lane = lanes.get(letter) || [];
    lane.push({
      ...node,
      id: `${letter}:${node.stageKey}:${lane.length}`,
      pathLetter: letter,
      stageLabel: stageLabel.get(node.stageKey) || node.stageKey,
      edgeLabel: '',
    });
    lanes.set(letter, lane);
  };

  for (const entry of feed) {
    const letter = entry.pathLetter;
    if (!lanes.has(letter)) continue;

    if (entry.kind === 'version') {
      const v = entry.data as { label: string; origin: string };
      push(letter, {
        stageKey: 'documento',
        title:
          v.origin === 'manual' ? 'Documento carregado' : v.origin === 'chat_change' ? 'Documento revisto' : 'Documento gerado',
        detail: v.label,
        entries: [entry],
        at: entry.at,
      });
      continue;
    }
    if (entry.kind === 'conversion') {
      const c = entry.data as { state: string };
      push(letter, {
        stageKey: 'pdf',
        title: c.state === 'erro' ? 'Conversão falhou' : 'PDF final gerado',
        detail: c.state === 'aprovado_para_envio' ? 'aprovado' : c.state === 'desatualizado' ? 'desatualizado' : '',
        entries: [entry],
        at: entry.at,
      });
      continue;
    }
    if (entry.kind === 'turn') {
      const t = entry.data as { status: string };
      push(letter, {
        stageKey: 'revisao',
        title: 'Pedido de alteração',
        detail: t.status === 'discarded' ? 'descartado' : t.status === 'pending_confirmation' ? 'por confirmar' : 'aplicado',
        entries: [entry],
        at: entry.at,
      });
      continue;
    }
    if (!entry.kind.startsWith('event:')) continue;
    const key = entry.kind.slice(6);
    if (!isEventKind(key)) continue;
    // Where the step belongs — a recomeço at the phase it went back to, a failure at the
    // phase it failed in, everything else at its own phase.
    const stageKey = eventPhase(key, entry.data);
    if (!stageKey || !stageLabel.has(stageKey)) continue;

    // A milestone becomes its own node; everything else rides along inside the node of the
    // same phase, so the details panel keeps the full record without visual noise. Which
    // is which, and what the card says, both come from the shared event table.
    const title = EVENTS[key].milestone ? eventNodeTitle(key) : null;
    const milestone = title ? { title, detail: nodeDetail(key, entry.data) } : null;
    if (!milestone) {
      const lane = lanes.get(letter) || [];
      const host = [...lane].reverse().find((n) => n.stageKey === stageKey);
      if (host) {
        host.entries.push(entry);
        continue;
      }
      // Nothing to ride along with yet: this entry OPENS its phase, so it becomes the node.
      // Dropping it is how narrative_markers_stripped used to vanish when it came first.
      push(letter, {
        stageKey,
        title: stageLabel.get(stageKey) || stageKey,
        detail: nodeDetail(key, entry.data),
        entries: [entry],
        at: entry.at,
      });
      continue;
    }
    push(letter, {
      stageKey,
      title: milestone.title,
      detail: milestone.detail,
      badge: key === 'analysis_closed' ? '' : undefined,
      entries: [entry],
      at: entry.at,
    });
  }

  // Edge labels: what the transition MEANS, not just where it lands.
  const order = new Map(stages.map((s, i) => [s.key, i]));
  for (const [letter, lane] of lanes) {
    lane.sort((a, b) => a.at - b.at);
    lane.forEach((node, i) => {
      if (i === 0) {
        const path = paths.find((p) => p.letter === letter);
        node.edgeLabel = path?.parentLabel ? `ramifica de ${path.parentLabel}` : 'início da análise';
        return;
      }
      node.edgeLabel = transitionLabel(lane[i - 1], node, order);
    });
  }
  return lanes;
}

/** Phrasings for the step between two nodes — the edge has to earn its place. */
const BY_TITLE: Record<string, string> = {
  'Análise concluída': 'e-mail aprovado',
  'Documento revisto': 'alteração confirmada',
  'Documento carregado': 'versão carregada à mão',
  'Documento gerado': 'escrito a partir dos itens',
  'Conversão falhou': 'a conversão falhou',
  'PDF final gerado': 'documento Word convertido',
  'PDF final aprovado': 'PDF revisto e aprovado',
  'Documento Word aprovado': 'documento aprovado',
  'Análise aprovada': 'itens revistos e aprovados',
  'Análise processada': 'documentos lidos e extraídos',
  'Processamento recusado': 'processamento recusado',
  'Pedido de alteração': 'pedido de alteração no chat',
  'Rascunho de e-mail': 'e-mail com o PDF em anexo',
  'Relações identificadas': 'relações propostas',
  'Recomeço a partir daqui': 'recomeço pedido aqui',
};

const BY_STAGE_PAIR: Record<string, string> = {
  'configuracao>extracao': 'documentos confirmados',
  'extracao>revisao': 'resultados prontos para rever',
  'revisao>documento': 'itens aceites — a escrever',
  'documento>pdf': 'a converter em PDF',
  'pdf>email': 'PDF aprovado — a preparar',
};

const SAME_STAGE: Record<string, string> = {
  configuracao: 'configuração ajustada',
  extracao: 'novo processamento',
  revisao: 'novo pedido sobre os itens',
  documento: 'nova versão do documento',
  pdf: 'nova conversão',
  email: 'rascunho atualizado',
};

function transitionLabel(prev: GraphNode, node: GraphNode, order: Map<string, number>): string {
  const byTitle = BY_TITLE[node.title];
  if (byTitle) return byTitle;
  if (prev.stageKey === node.stageKey) return SAME_STAGE[node.stageKey] || 'continua';
  const pair = BY_STAGE_PAIR[`${prev.stageKey}>${node.stageKey}`];
  if (pair) return pair;
  const from = order.get(prev.stageKey) ?? 0;
  const to = order.get(node.stageKey) ?? 0;
  return to < from ? `volta a ${node.stageLabel}` : `segue para ${node.stageLabel}`;
}

// Layout: nodes are cards on a free canvas, placed by SEQUENCE (not by phase — a phase can
// hold as many nodes as it needs). A forked path starts one slot to the right of the node
// it forked from, so the branch is a real connector between two real cards.
const GUTTER = 184;
const CARD_W = 196;
const CARD_H = 88;
const COL_GAP = 148;
const ROW_GAP = 56;

const xOf = (slot: number) => slot * (CARD_W + COL_GAP);
const yOf = (lane: number) => lane * (CARD_H + ROW_GAP);

export function pathDisplayName(path: GraphPath): string {
  if (!path.parentVersionId) return 'Percurso principal';
  return ({
    configuracao: 'Configuração revista',
    extracao: 'Extração repetida',
    revisao: 'Revisão retomada',
    documento: 'Nova versão do documento',
    pdf: 'PDF repetido',
    email: 'E-mail revisto',
  } as Record<string, string>)[path.parentStage] || 'Tentativa alternativa';
}

export function WorkflowGraph({
  feed,
  paths,
  stages,
  activePath,
  viewingPath,
  selectedNodeId,
  onSelect,
  onViewPath,
  tutorialNodeTarget,
  tutorialNodeStage,
  tutorialPathTarget,
  tutorialPathLetter,
}: {
  feed: GraphFeedEntry[];
  paths: GraphPath[];
  stages: StageMeta[];
  activePath: string;
  viewingPath: string;
  selectedNodeId: string | null;
  onSelect: (node: GraphNode) => void;
  onViewPath: (letter: string) => void;
  tutorialNodeTarget?: string;
  tutorialNodeStage?: string;
  tutorialPathTarget?: string;
  tutorialPathLetter?: string;
}) {
  const lanes = buildGraph(feed, paths, stages);

  // Which node produced each version — the fork's parent version tells us which LANE the
  // branch leaves; its parentStage tells us which node in that lane it leaves FROM.
  const nodeOfVersion = new Map<string, GraphNode>();
  for (const lane of lanes.values()) {
    for (const node of lane) {
      for (const entry of node.entries) {
        if (entry.kind === 'version') nodeOfVersion.set(String(entry.data.versionId), node);
      }
    }
  }
  const anchorOf = (path: GraphPath): GraphNode | undefined => {
    const versionNode = path.parentVersionId ? nodeOfVersion.get(path.parentVersionId) : undefined;
    if (!versionNode) return undefined;
    if (!path.parentStage || path.parentStage === versionNode.stageKey) return versionNode;
    // The restart happened at another stage of the same lane — branch from THAT step,
    // the last one of that stage before the fork.
    const lane = lanes.get(versionNode.pathLetter) || [];
    const forkAt = path.createdAt ?? Number.MAX_SAFE_INTEGER;
    const atStage = lane.filter((n) => n.stageKey === path.parentStage && n.at <= forkAt);
    return atStage.length ? atStage[atStage.length - 1] : versionNode;
  };

  // Slots, left to right. Paths come in creation order, so a parent is always placed first.
  const slotOf = new Map<string, number>();
  const laneIndex = new Map<string, number>();
  const branches: Array<{ from: GraphNode; to: GraphNode; label: string }> = [];
  let maxSlot = 0;
  paths.forEach((path, index) => {
    laneIndex.set(path.letter, index);
    const lane = lanes.get(path.letter) || [];
    const parent = anchorOf(path);
    const start = parent ? (slotOf.get(parent.id) ?? 0) + 1 : 0;
    lane.forEach((node, i) => {
      slotOf.set(node.id, start + i);
      maxSlot = Math.max(maxSlot, start + i);
    });
    if (parent && lane[0]) {
      branches.push({
        from: parent,
        to: lane[0],
        label: `ramifica de ${parent.detail || parent.title}${path.parentLabel ? ` (${path.parentLabel})` : ''}`,
      });
    }
  });

  const width = xOf(maxSlot) + CARD_W + 8;
  const height = yOf(paths.length - 1) + CARD_H;

  return (
    <div className="flex">
      {/* the path handles live OUTSIDE the scroller, so a lane stays named however far
          right the graph is scrolled */}
      <div className="relative shrink-0" style={{ width: GUTTER, height }}>
        {paths.map((path) => (
          <button
            key={path.letter}
            type="button"
            data-tutorial-target={tutorialPathTarget && (!tutorialPathLetter || tutorialPathLetter === path.letter) ? tutorialPathTarget : undefined}
            onClick={() => onViewPath(path.letter)}
            title={`${pathDisplayName(path)} — identificador interno ${path.letter.toUpperCase()}`}
            className={`absolute flex max-w-[11rem] items-center gap-1 rounded-md px-2 py-1 text-left text-xs ${
              path.letter === viewingPath ? `${toneOf(path.letter)} font-medium` : 'ui-btn-secondary'
            }`}
            style={{ left: 0, top: yOf(laneIndex.get(path.letter) ?? 0) + CARD_H / 2 - 14 }}
          >
            <span aria-hidden>⑂</span>
            <span className="truncate">{pathDisplayName(path)}</span>
            {path.letter === activePath ? (
              <span aria-hidden title="caminho ativo">
                ●
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
      <div className="relative" style={{ width, height, minWidth: '100%' }}>
        {paths.map((path) => {
          const lane = lanes.get(path.letter) || [];
          const row = laneIndex.get(path.letter) ?? 0;
          return (
            <div key={path.letter}>
              {lane.map((node, i) => {
                const slot = slotOf.get(node.id) ?? 0;
                const left = xOf(slot);
                const top = yOf(row);
                const selected = selectedNodeId === node.id;
                const time = new Date(node.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
                const extra = node.entries.length > 1 ? ` · +${node.entries.length - 1}` : '';
                return (
                  <div key={node.id}>
                    {/* the edge that leads INTO this node, and what it meant */}
                    {i > 0 ? (
                      <>
                        <span
                          aria-hidden
                          className="absolute h-0.5 rounded bg-accent"
                          style={{ left: left - COL_GAP, top: top + CARD_H / 2 - 1, width: COL_GAP - 6 }}
                        />
                        <span
                          aria-hidden
                          className="absolute h-0 w-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-accent"
                          style={{ left: left - 8, top: top + CARD_H / 2 - 4 }}
                        />
                        <span
                          className="absolute text-center text-[10px] leading-tight ui-text-subtle"
                          style={{ left: left - COL_GAP + 8, top: top + CARD_H / 2 - 32, width: COL_GAP - 16 }}
                        >
                          {node.edgeLabel}
                        </span>
                      </>
                    ) : null}

                    <button
                      type="button"
                      data-tutorial-target={tutorialNodeTarget && (!tutorialNodeStage || tutorialNodeStage === node.stageKey) ? tutorialNodeTarget : undefined}
                      onClick={() => onSelect(node)}
                      title={[
                        node.badge ?? node.stageLabel,
                        `${node.title}${node.detail ? ` — ${node.detail}` : ''}`,
                        new Date(node.at).toLocaleString('pt-PT'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      className={`absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-lg border-2 px-2.5 py-2 text-left transition-colors ${
                        selected ? 'border-accent bg-accent-ghost' : 'border-line1 bg-bg1 hover:border-accent'
                      }`}
                      style={{ left, top, width: CARD_W, height: CARD_H }}
                    >
                      {(node.badge ?? node.stageLabel) ? (
                        <span className="truncate text-[10px] font-medium uppercase tracking-wide ui-text-subtle">
                          {node.badge ?? node.stageLabel}
                        </span>
                      ) : null}
                      {/* Two lines rather than an ellipsis: the whole point of the title is
                          to say WHICH artifact the step was about. */}
                      <span className="line-clamp-2 text-xs font-medium leading-tight text-ink0">{node.title}</span>
                      <span className="truncate text-[10px] ui-text-muted">
                        {[node.detail, time + extra].filter(Boolean).join(' · ')}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* the branches: parent card → down → first card of the new path */}
        {branches.map(({ from, to, label }) => {
          const fx = xOf(slotOf.get(from.id) ?? 0) + CARD_W / 2;
          const fy = yOf(laneIndex.get(from.pathLetter) ?? 0) + CARD_H;
          const ty = yOf(laneIndex.get(to.pathLetter) ?? 0) + CARD_H / 2;
          const tx = xOf(slotOf.get(to.id) ?? 0);
          return (
            <div key={`${from.id}->${to.id}`}>
              <span aria-hidden className="absolute w-0.5 rounded bg-accent" style={{ left: fx - 1, top: fy, height: ty - fy }} />
              <span
                aria-hidden
                className="absolute h-0.5 rounded bg-accent"
                style={{ left: fx, top: ty - 1, width: Math.max(0, tx - fx - 6) }}
              />
              <span
                aria-hidden
                className="absolute h-0 w-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-accent"
                style={{ left: tx - 8, top: ty - 4 }}
              />
              <span
                className="absolute text-[10px] leading-tight ui-text-subtle"
                style={{ left: fx + 8, top: fy + 8, width: CARD_W }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
