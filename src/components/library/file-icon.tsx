import { FileImage, FileText, FileType, Folder, Mail, File as GenericFile } from 'lucide-react';

// The first column of OneDrive's list is an icon, and it is genuinely useful — you find a
// PDF among twenty Word files by shape before you read a single name.
//
// Emoji were the obvious shortcut and the wrong one: 📄 and 📁 render differently on every
// platform, and at 16px several are indistinguishable.

const ICONS = {
  folder: Folder,
  pdf: FileType,
  image_jpeg: FileImage,
  image_png: FileImage,
  office: FileText,
  email_eml: Mail,
  email_msg: Mail,
  email_attachment: Mail,
  text: FileText,
} as const;

export function FileIcon({
  kind,
  isFolder = false,
  size = 16,
}: {
  kind?: string;
  isFolder?: boolean;
  size?: number;
}) {
  const Glyph = isFolder ? ICONS.folder : ICONS[kind as keyof typeof ICONS] || GenericFile;
  // Folders take the accent so the eye separates them from files without reading anything.
  return (
    <Glyph
      size={size}
      aria-hidden
      className={isFolder ? 'shrink-0 text-accent' : 'shrink-0 ui-text-muted'}
      {...(isFolder ? { fill: 'currentColor', fillOpacity: 0.15 } : {})}
    />
  );
}
