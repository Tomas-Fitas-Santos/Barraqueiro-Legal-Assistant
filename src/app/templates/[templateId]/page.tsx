import { notFound } from 'next/navigation';

import { EmailTemplateEditorView } from '@/components/templates/email-template-editor-view';
import { ExtractionTemplateEditorView } from '@/components/templates/extraction-template-editor-view';
import { TemplateEditorView } from '@/components/templates/template-editor-view';
import { requirePageSession } from '@/lib/server/page-auth';
import { analysisTypeOfExtractionTemplate } from '@/lib/server/repo/extraction-template';
import { BUILTIN_EMAIL_TEMPLATES, BUILTIN_TEMPLATE_BLOCKS } from '@/lib/server/repo/template-blocks';

export default async function TemplateEditorPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await params;
  await requirePageSession({ next: `/templates/${templateId}` });
  if (BUILTIN_EMAIL_TEMPLATES[templateId]) return <EmailTemplateEditorView templateId={templateId} />;
  if (analysisTypeOfExtractionTemplate(templateId)) return <ExtractionTemplateEditorView templateId={templateId} />;
  if (!BUILTIN_TEMPLATE_BLOCKS[templateId]) notFound();
  return <TemplateEditorView templateId={templateId} />;
}
