import { fetchNewEmails } from "./gmail";
import { isEmailProcessed, markEmailProcessed, createDocketEntry, getDocketEntryByEmailId, getPendingClassificationEntries, updateDocketClassification } from "./db";
import { parseAttachments, truncateText } from "./parser";
import { classifyEmail } from "./classifier";
import type { ClassificationResult, RawAttachment, ScanResult } from "@/types";

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ProcessResult {
  docketId: number;
  status?: string;
  classification?: {
    relevant: boolean;
    item_type: string | null;
    department: string | null;
    summary: string;
    confidence: string;
  };
}

/**
 * Quick-save: create a docket entry immediately with placeholder classification.
 * The real AI classification is deferred to the cron job or next /api/scan call.
 * Returns in ~100ms instead of 10-30 seconds.
 */
export function quickSaveEmail(email: {
  id: string;
  from: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml?: string;
  attachmentFilenames: string[];
}): ProcessResult {
  // Check if already processed
  if (isEmailProcessed(email.id)) {
    const existing = getDocketEntryByEmailId(email.id);
    const err = new Error("This email has already been sent to the docket.");
    (err as Error & { code: string; docketId?: number }).code = "ALREADY_PROCESSED";
    if (existing) (err as Error & { docketId?: number }).docketId = existing.id;
    throw err;
  }

  let bodyText = email.bodyText || stripHtml(email.bodyHtml || "");
  bodyText = truncateText(bodyText, 8000);

  // Create entry with placeholder classification — will be updated by classifyPendingEntries()
  const placeholderClassification: ClassificationResult = {
    relevant: true,
    confidence: "pending",
    item_type: null,
    department: null,
    summary: email.subject,
    extracted_fields: {} as ClassificationResult["extracted_fields"],
    completeness: { needs_cfo_certification: false, needs_attorney_review: false, missing_block_lot: false, missing_statutory_citation: false, notes: [] },
  };

  const docketId = createDocketEntry({
    emailId: email.id,
    emailFrom: email.from,
    emailSubject: email.subject,
    emailDate: email.date,
    emailBodyPreview: bodyText.slice(0, 500),
    classification: placeholderClassification,
    attachmentFilenames: email.attachmentFilenames,
  });

  markEmailProcessed(email.id);

  console.log(`[Ingest] Quick-saved: "${email.subject}" → pending classification`);

  return { docketId, status: "pending_classification" };
}

/**
 * Process a single email through the classification pipeline and create a docket entry.
 * Used by both runScan() and the /api/ingest endpoint.
 */
export async function processSingleEmail(email: {
  id: string;
  from: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: RawAttachment[];
}): Promise<ProcessResult> {
  // Check if already processed
  if (isEmailProcessed(email.id)) {
    const existing = getDocketEntryByEmailId(email.id);
    const err = new Error("This email has already been sent to the docket.");
    (err as Error & { code: string; docketId?: number }).code = "ALREADY_PROCESSED";
    if (existing) (err as Error & { docketId?: number }).docketId = existing.id;
    throw err;
  }

  const parsedAttachments = await parseAttachments(email.attachments);

  let bodyText = email.bodyText || stripHtml(email.bodyHtml || "");
  bodyText = truncateText(bodyText, 8000);

  const attachmentTexts = parsedAttachments.map((att) => ({
    filename: att.filename,
    text: truncateText(att.text, 4000),
  }));

  const classification = await classifyEmail(
    email.from,
    email.subject,
    bodyText,
    attachmentTexts
  );

  const docketId = createDocketEntry({
    emailId: email.id,
    emailFrom: email.from,
    emailSubject: email.subject,
    emailDate: email.date,
    emailBodyPreview: bodyText.slice(0, 500),
    classification,
    attachmentFilenames: email.attachments.map((a) => a.filename),
  });

  markEmailProcessed(email.id);

  console.log(
    `[Scan] Processed: "${email.subject}" → ${classification.item_type} (${classification.confidence})`
  );

  return {
    docketId,
    classification: {
      relevant: classification.relevant,
      item_type: classification.item_type,
      department: classification.department,
      summary: classification.summary,
      confidence: classification.confidence,
    },
  };
}

/**
 * Classify docket entries that were quick-saved with confidence='pending'.
 * Called by the cron job to process deferred classifications.
 */
export async function classifyPendingEntries(): Promise<number> {
  const pending = getPendingClassificationEntries();
  if (pending.length === 0) return 0;

  let classified = 0;
  for (const entry of pending) {
    try {
      const bodyText = truncateText(entry.email_body_preview, 8000);

      // Parse attachment filenames for context (no actual content since we didn't store it)
      let attachmentFilenames: string[] = [];
      try { attachmentFilenames = JSON.parse(entry.attachment_filenames); } catch { /* ignore */ }

      const attachmentTexts = attachmentFilenames.map((f) => ({
        filename: f,
        text: "",
      }));

      const classification = await classifyEmail(
        entry.email_from,
        entry.email_subject,
        bodyText,
        attachmentTexts
      );

      updateDocketClassification(entry.id, classification);
      classified++;
      console.log(`[Classify] Classified: "${entry.email_subject}" → ${classification.item_type} (${classification.confidence})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Classify] Error classifying entry #${entry.id}: ${message}`);
      // Mark as classified with low confidence to avoid retrying forever
      updateDocketClassification(entry.id, {
        relevant: true,
        confidence: "low",
        item_type: "other",
        department: null,
        summary: entry.email_subject,
        extracted_fields: {} as ClassificationResult["extracted_fields"],
        completeness: { needs_cfo_certification: false, needs_attorney_review: false, missing_block_lot: false, missing_statutory_citation: false, notes: [] },
      });
    }
  }

  return classified;
}

export async function runScan(): Promise<ScanResult> {
  const result: ScanResult = {
    emails_found: 0,
    emails_processed: 0,
    emails_skipped: 0,
    docket_entries_created: 0,
    errors: [],
  };

  const emails = await fetchNewEmails(20);
  result.emails_found = emails.length;

  for (const email of emails) {
    try {
      if (isEmailProcessed(email.id)) {
        result.emails_skipped++;
        continue;
      }

      await processSingleEmail({
        id: email.id,
        from: email.from,
        subject: email.subject,
        date: email.date,
        bodyText: email.bodyText,
        bodyHtml: email.bodyHtml,
        attachments: email.attachments,
      });

      result.emails_processed++;
      result.docket_entries_created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Error processing "${email.subject}": ${message}`);
      try {
        markEmailProcessed(email.id);
      } catch {
        // ignore — best effort to avoid retrying
      }
    }
  }

  return result;
}
