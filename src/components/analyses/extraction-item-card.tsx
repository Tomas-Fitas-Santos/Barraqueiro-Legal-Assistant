'use client';

import type { ReactNode } from 'react';

import { confidenceLabel } from '@/lib/extraction-fields';
import {
  RELATION_TYPE_LABELS,
  STATEMENT_TYPE_LABELS,
  type RelationType,
  type StatementType,
} from '@/lib/types';

// One extracted item, as the user reads it.
//
// It lives on its own because there are two places that show one: the review screen inside
// an analysis, and the preview of a `dados-*.json` in the library. Those are the same
// artefact seen at two moments, so they must not be two renderings that drift apart — a
// preview that lays out the fields slightly differently, or quietly drops the citation, is
// a preview of something other than the record.
//
// What differs between the two is not presentation but CAPABILITY: the review edits fields
// and opens sources, the preview reads a file that is finished. So the card takes those as
// slots and renders identically either way.

export type ExtractionCardItem = {
  itemId: string;
  kind: string;
  payload: Record<string, unknown>;
  accepted: boolean;
  rejectionReason?: string;
};

/**
 * Confiança, in the client's vocabulary (§2.2: alta / média / baixa), derived from the
 * evidence quality the model reported. One source of truth — asking the model for both
 * would let it contradict itself.
 */
export function confidenceOf(evidenceQuality: string): { label: string; tone: string } {
  // The words come from the shared list; only the colour is this component's business.
  const tone =
    evidenceQuality === 'direct' ? 'ui-pill-ok' : evidenceQuality === 'indirect' ? 'ui-pill-info' : 'ui-pill-warn';
  return { label: confidenceLabel(evidenceQuality), tone };
}

export function ExtractionItemCard({
  item,
  fields,
  renderValue,
  sourceName,
  onOpenSource,
  citationTarget,
  footer,
  borderClassName,
  showField,
}: {
  item: ExtractionCardItem;
  /** The fields this item was MADE with, so an old record reads as what it was. */
  fields: Array<[string, string]>;
  /** How a value is shown — plain text in a preview, an editable field in the review. */
  renderValue: (field: string, value: string) => ReactNode;
  sourceName: (documentId: string) => string;
  /** Absent in a preview of a finished file: there is nothing to navigate to. */
  onOpenSource?: (documentId: string, page: number, excerpt: string) => void;
  /** Optional tour anchor used by the isolated tutorial replica. */
  citationTarget?: string;
  footer?: ReactNode;
  /** The review marks an undecided legal item; a preview has no such state. */
  borderClassName?: string;
  /** The review also shows a field a user has just typed into, empty in the payload. */
  showField?: (field: string) => boolean;
}) {
  const payload = item.payload as Record<string, string | number | boolean>;
  const confidence = confidenceOf(String(payload.evidence_quality || ''));
  const sourceId = String(payload.source_document_id || '');
  const page = Number(payload.source_page || 0);
  const excerpt = String(payload.source_excerpt || '');
  const legal = payload.requires_legal_decision === true;

  return (
    <div
      className={`ui-soft-panel rounded-lg border p-3 ${
        borderClassName || (item.accepted ? 'border-line0' : 'border-danger')
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="ui-pill-info rounded-md px-1.5 py-0.5 text-xs">
          {item.kind === 'statement'
            ? STATEMENT_TYPE_LABELS[String(payload.statement_type || 'other') as StatementType] ||
              String(payload.statement_type)
            : RELATION_TYPE_LABELS[String(payload.relationship_type) as RelationType] ||
              String(payload.relationship_type || '')}
        </span>
        {/* A rejected item's confidence is exactly the claim that failed validation —
            showing "Confiança alta" beside "the excerpt was not on that page" would be
            repeating the thing the app just refused to believe. */}
        {item.accepted ? (
          <span className={`${confidence.tone} rounded-md px-1.5 py-0.5 text-xs`}>{confidence.label}</span>
        ) : (
          <span className="ui-pill-error rounded-md px-1.5 py-0.5 text-xs">Não validado</span>
        )}
        {payload.ai_suggestion === true ? (
          <span className="ui-pill-warn rounded-md px-1.5 py-0.5 text-xs">Sugestão da IA</span>
        ) : null}
        {legal ? <span className="ui-pill-warn rounded-md px-1.5 py-0.5 text-xs">Requer decisão jurídica</span> : null}
      </div>

      {item.kind === 'statement' ? (
        <div className="mb-1.5 text-base text-ink0">{renderValue('content', String(payload.content || ''))}</div>
      ) : null}

      <dl className="m-0 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
        {fields.map(([field, label]) =>
          String(payload[field] || '') || showField?.(field) ? (
            <div key={field} className="contents">
              <dt className="ui-text-muted">{label}</dt>
              <dd className="m-0">{renderValue(field, String(payload[field]))}</dd>
            </div>
          ) : null,
        )}
      </dl>

      {/* The citation: the source, the page, and the excerpt that has to be on it. */}
      {sourceId ? (
        <p className="mt-2 mb-0 text-sm">
          <span className="ui-text-muted">Fonte: </span>
          {onOpenSource ? (
            <button type="button" data-tutorial-target={citationTarget} onClick={() => onOpenSource(sourceId, page, excerpt)} className="ui-link">
              {sourceName(sourceId)}
              {payload.source_version ? ` (${payload.source_version})` : ''}
              {page > 0 ? `, p. ${page}` : ''}
            </button>
          ) : (
            <span className="text-ink1">
              {sourceName(sourceId)}
              {payload.source_version ? ` (${payload.source_version})` : ''}
              {page > 0 ? `, p. ${page}` : ''}
            </span>
          )}
          {excerpt ? <span className="ui-text-subtle"> — “{excerpt.slice(0, 120)}”</span> : null}
        </p>
      ) : null}

      {!item.accepted && item.rejectionReason ? (
        <div className="mt-3 rounded-md border-l-4 border-l-danger bg-danger-soft px-3 py-2 text-sm">
          <p className="m-0 font-medium text-danger">Excluído automaticamente desta versão</p>
          <p className="mt-1 mb-0 text-ink1"><strong>Motivo:</strong> {item.rejectionReason}</p>
          <p className="mt-1 mb-0 ui-text-muted">Este resultado não entra no documento. Pode corrigir os campos e guardar uma nova extração.</p>
        </div>
      ) : null}

      {footer}
    </div>
  );
}
