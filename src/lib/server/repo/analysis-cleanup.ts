import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { ApiError } from '@/app/api/_helpers';
import { documentKind } from '@/lib/library-layout';
import { getDb } from '@/lib/server/db';
import { deleteItem } from '@/lib/server/msgraph';
import { LEGAL_FILES_DIR } from '@/lib/server/paths';

export const CLEANUP_CONFIRMATION = 'REMOVER_TODAS_AS_ANALISES_E_RESULTADOS_EXCLUSIVOS';

type AnalysisInventory = {
  analysisId: string;
  type: string;
  mainDocumentId: string;
  mainDocumentName: string;
  state: string;
  createdAt: number;
};
type OutputInventory = {
  conversionId: string;
  analysisId: string;
  versionId: string;
  pdfFilename: string;
  jsonFilename: string;
  oneDriveIds: string[];
  hashes: string[];
};
type DocumentInventory = { documentId: string; name: string; path: string; driveItemId: string; sha256: string };

export type AnalysisCleanupInventory = {
  generatedAt: number;
  analyses: AnalysisInventory[];
  outputs: OutputInventory[];
  exclusiveLibraryDocuments: DocumentInventory[];
  oneDriveItemIds: string[];
  blockers: Array<{ relationId: string; documentId: string; reason: string }>;
  deleteCounts: Record<string, number>;
  preserveCounts: Record<string, number>;
  inventoryHash: string;
};

function placeholders(values: string[]): string {
  return values.map(() => '?').join(',');
}

export function analysisCleanupInventory(): AnalysisCleanupInventory {
  const db = getDb();
  const analyses = (db.prepare(
    `SELECT a.analysis_id, a.type, a.main_document_id, d.name AS main_document_name, a.state, a.created_at
       FROM analyses a JOIN documents d ON d.document_id = a.main_document_id
      ORDER BY a.created_at, a.analysis_id`,
  ).all() as Array<{ analysis_id: string; type: string; main_document_id: string; main_document_name: string; state: string; created_at: number }>).map((row) => ({
    analysisId: row.analysis_id, type: row.type, mainDocumentId: row.main_document_id,
    mainDocumentName: row.main_document_name, state: row.state, createdAt: row.created_at,
  }));
  const outputs = (db.prepare(
    `SELECT conversion_id, analysis_id, version_id, pdf_filename, json_filename,
            onedrive_docx_id, onedrive_pdf_id, onedrive_json_id,
            docx_sha256, pdf_sha256, json_sha256
       FROM conversions ORDER BY analysis_id, created_at, conversion_id`,
  ).all() as Array<Record<string, string>>).map((row) => ({
    conversionId: row.conversion_id,
    analysisId: row.analysis_id,
    versionId: row.version_id,
    pdfFilename: row.pdf_filename,
    jsonFilename: row.json_filename,
    oneDriveIds: [row.onedrive_docx_id, row.onedrive_pdf_id, row.onedrive_json_id].filter(Boolean),
    hashes: [row.docx_sha256, row.pdf_sha256, row.json_sha256].filter(Boolean),
  }));
  const outputIds = [...new Set(outputs.flatMap((output) => output.oneDriveIds))];
  const outputHashes = [...new Set(outputs.flatMap((output) => output.hashes))];
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (outputIds.length) {
    clauses.push(`drive_item_id IN (${placeholders(outputIds)})`);
    bindings.push(...outputIds);
  }
  if (outputHashes.length) {
    clauses.push(`sha256 IN (${placeholders(outputHashes)})`);
    bindings.push(...outputHashes);
  }
  const candidates = clauses.length
    ? db.prepare(`SELECT document_id, name, path, drive_item_id, sha256 FROM documents WHERE removed = 0 AND (${clauses.join(' OR ')}) ORDER BY path, name`).all(...bindings) as Array<{ document_id: string; name: string; path: string; drive_item_id: string; sha256: string }>
    : [];
  const exclusiveLibraryDocuments = candidates.filter((row) => documentKind(row.path) === 'generated').map((row) => ({
    documentId: row.document_id, name: row.name, path: row.path, driveItemId: row.drive_item_id, sha256: row.sha256,
  }));
  const documentIds = exclusiveLibraryDocuments.map((document) => document.documentId);
  const blockers = documentIds.length
    ? (db.prepare(
        `SELECT relation_id, from_document_id, to_document_id
           FROM relations
          WHERE status = 'confirmed'
            AND (from_document_id IN (${placeholders(documentIds)}) OR to_document_id IN (${placeholders(documentIds)}))`,
      ).all(...documentIds, ...documentIds) as Array<{ relation_id: string; from_document_id: string; to_document_id: string }>).map((row) => {
        const documentId = documentIds.includes(row.from_document_id) ? row.from_document_id : row.to_document_id;
        return { relationId: row.relation_id, documentId, reason: 'Um resultado exclusivo participa numa relação confirmada.' };
      })
    : [];

  const analysisCount = analyses.length;
  const countFor = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const deleteCounts = {
    analyses: analysisCount,
    analysisDocuments: countFor('analysis_documents'),
    extractionItems: countFor('analysis_items'),
    extractions: countFor('analysis_extractions'),
    events: countFor('analysis_events'),
    versions: countFor('analysis_versions'),
    paths: countFor('analysis_paths'),
    chatTurns: countFor('analysis_turns'),
    conversions: outputs.length,
    libraryDocuments: exclusiveLibraryDocuments.length,
    oneDriveItems: outputIds.length,
  };
  const survivingDocuments = (db.prepare('SELECT path FROM documents WHERE removed = 0').all() as Array<{ path: string }>).filter(
    (row) => documentKind(row.path) === 'official',
  ).length;
  const preserveCounts = {
    officialDocuments: survivingDocuments,
    templates: countFor('templates'),
    confirmedRelations: Number((db.prepare("SELECT COUNT(*) AS n FROM relations WHERE status = 'confirmed'").get() as { n: number }).n),
    settings: countFor('settings'),
    users: countFor('users'),
    tutorialFixtures: countFor('tutorial_fixtures'),
    tutorialRuns: countFor('tutorial_runs'),
  };
  const stable = { analyses, outputs, exclusiveLibraryDocuments, oneDriveItemIds: outputIds.sort(), blockers, deleteCounts, preserveCounts };
  const inventoryHash = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return { generatedAt: Date.now(), ...stable, inventoryHash };
}

export async function executeAnalysisCleanup(inventoryHash: string, confirmation: string) {
  if (confirmation !== CLEANUP_CONFIRMATION) throw new ApiError('A frase de confirmação não corresponde ao âmbito aprovado.', 400);
  const inventory = analysisCleanupInventory();
  if (inventory.inventoryHash !== inventoryHash) throw new ApiError('O inventário mudou. Faça um novo dry-run antes de confirmar.', 409);
  if (inventory.blockers.length) throw new ApiError('O inventário contém relações confirmadas; a limpeza foi bloqueada.', 409);

  // External deletes come first and are idempotent (404 is success). If Graph fails halfway,
  // the unchanged DB inventory can be submitted again after the cause is corrected.
  for (const itemId of inventory.oneDriveItemIds) await deleteItem(itemId);

  const db = getDb();
  const documentIds = inventory.exclusiveLibraryDocuments.map((document) => document.documentId);
  const versionHashes = inventory.outputs.flatMap((output) => output.hashes);
  db.exec('BEGIN');
  try {
    if (documentIds.length) {
      const marks = placeholders(documentIds);
      db.prepare(`DELETE FROM relation_candidates WHERE from_document_id IN (${marks}) OR to_document_id IN (${marks})`).run(...documentIds, ...documentIds);
      db.prepare(`DELETE FROM relation_coverage WHERE from_document_id IN (${marks}) OR to_document_id IN (${marks})`).run(...documentIds, ...documentIds);
      const documentHashes = inventory.exclusiveLibraryDocuments.map((document) => document.sha256).filter(Boolean);
      if (documentHashes.length) {
        const hashMarks = placeholders(documentHashes);
        db.prepare(`DELETE FROM renditions WHERE source_sha256 IN (${hashMarks})`).run(...documentHashes);
      }
      db.prepare(`DELETE FROM document_pages WHERE document_id IN (${marks})`).run(...documentIds);
      db.prepare(`DELETE FROM segments WHERE document_id IN (${marks})`).run(...documentIds);
      db.prepare(`DELETE FROM documents WHERE document_id IN (${marks})`).run(...documentIds);
    }
    for (const table of ['analysis_documents', 'analysis_items', 'analysis_extractions', 'analysis_events', 'analysis_turns', 'conversions', 'analysis_versions', 'analysis_paths']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare('DELETE FROM analyses').run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // Content-addressed caches are removed only when no surviving row references the hash.
  for (const hash of new Set(versionHashes.filter(Boolean))) {
    const referenced = Number((db.prepare(
      `SELECT (SELECT COUNT(*) FROM analysis_versions WHERE sha256 = ?) +
              (SELECT COUNT(*) FROM conversions WHERE docx_sha256 = ? OR pdf_sha256 = ? OR json_sha256 = ?) AS n`,
    ).get(hash, hash, hash, hash) as { n: number }).n);
    if (referenced) continue;
    for (const directory of ['versions', 'pdfs', 'exports']) {
      const file = path.join(LEGAL_FILES_DIR, directory, hash);
      if (existsSync(file)) unlinkSync(file);
    }
  }
  return { ok: true, removed: inventory.deleteCounts, preserved: inventory.preserveCounts };
}
