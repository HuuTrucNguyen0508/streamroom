// Blob URLs for the chat's inline previews, and files pasted into the chat.

import { useEffect, useMemo, useState } from "preact/hooks";
import { previewKind } from "../rtc/files.ts";

/**
 * A blob URL for `blob`, typed as `mime` so a media element decodes it; revoked when it changes.
 * Call `failed` from the element's error event: a file whose bytes don't match its type gets no URL.
 */
export function usePreviewUrl(blob: Blob | null, mime: string): { url: string | null; failed: () => void } {
  const [broken, setBroken] = useState<string | null>(null);
  const url = useObjectUrl(blob, mime);
  return { url: url !== null && url !== broken ? url : null, failed: () => setBroken(url) };
}

function useObjectUrl(blob: Blob | null, mime: string): string | null {
  const kind = previewKind(mime);
  const typed = useMemo(() => (blob && kind ? new Blob([blob], { type: mime.split(";")[0]!.trim().toLowerCase() }) : null), [blob, kind, mime]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!typed) return void setUrl(null);
    const next = URL.createObjectURL(typed);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [typed]);
  return url;
}

/**
 * Files from the clipboard, or null when the paste should stay text. Office apps put a picture of
 * the selection next to its text and HTML; those pastes are text.
 */
export function pastedFiles(data: DataTransfer | null): File[] | null {
  if (!data || data.files.length === 0) return null;
  if (data.types.includes("text/plain") && data.types.includes("text/html")) return null;
  const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", ".");
  // Browsers call every pasted screenshot "image.png".
  return [...data.files].map((f) => (/^image\.\w+$/.test(f.name) ? new File([f], `Pasted image ${stamp}${f.name.slice(5)}`, { type: f.type, lastModified: f.lastModified }) : f));
}
