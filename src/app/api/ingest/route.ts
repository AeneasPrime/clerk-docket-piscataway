import { NextRequest, NextResponse } from "next/server";
import { quickSaveEmail } from "@/lib/scanner";

export async function POST(request: NextRequest) {
  // Validate API key
  const apiKey = process.env.INGEST_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: "server_error", message: "INGEST_API_KEY not configured." },
      { status: 500 }
    );
  }

  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${apiKey}`) {
    return NextResponse.json(
      { success: false, error: "unauthorized", message: "Invalid or missing API key." },
      { status: 401 }
    );
  }

  // Parse request body
  let body: {
    emailId: string;
    from: string;
    subject: string;
    date: string;
    bodyText: string;
    bodyHtml?: string;
    attachments?: { filename: string; mimeType: string; data: string }[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "validation_error", message: "Invalid JSON body." },
      { status: 400 }
    );
  }

  // Validate required fields
  if (!body.emailId || !body.from || !body.subject || !body.date || !body.bodyText) {
    return NextResponse.json(
      { success: false, error: "validation_error", message: "Missing required fields: emailId, from, subject, date, bodyText." },
      { status: 400 }
    );
  }

  // Extract attachment filenames (don't decode full binary — not needed for quick-save)
  const attachmentFilenames: string[] = [];
  if (body.attachments) {
    for (const att of body.attachments) {
      attachmentFilenames.push(att.filename);
    }
  }

  try {
    // Quick-save: creates docket entry immediately, defers AI classification to cron
    const result = quickSaveEmail({
      id: body.emailId,
      from: body.from,
      subject: body.subject,
      date: body.date,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      attachmentFilenames,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    // Handle "already processed" case
    if (err instanceof Error && (err as Error & { code?: string }).code === "ALREADY_PROCESSED") {
      return NextResponse.json(
        {
          success: false,
          error: "already_processed",
          message: err.message,
          docketId: (err as Error & { docketId?: number }).docketId,
        },
        { status: 409 }
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: "processing_error", message },
      { status: 500 }
    );
  }
}
