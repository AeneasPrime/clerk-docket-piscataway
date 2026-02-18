import { NextRequest, NextResponse } from "next/server";
import { getMeeting } from "@/lib/db";
import { generateMinutesDocx } from "@/lib/minutes-docx";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const meetingId = parseInt(id, 10);
    const meeting = getMeeting(meetingId);

    if (!meeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    if (!meeting.minutes) {
      return NextResponse.json(
        { error: "No minutes available for this meeting. Generate minutes first." },
        { status: 400 }
      );
    }

    const hasReviewMarkers = /\[REVIEW:[^\]]*\]/.test(meeting.minutes);
    const docxBuffer = await generateMinutesDocx({
      meetingDate: meeting.meeting_date,
      meetingType: meeting.meeting_type as "council" | "reorganization",
      minutes: meeting.minutes,
      isDraft: hasReviewMarkers,
    });

    const [y, m, d] = meeting.meeting_date.split("-");
    const typeCode = meeting.meeting_type === "reorganization" ? "reorg" : "council";
    const filename = `${m}-${d}-${y} ${typeCode}.docx`;

    return new NextResponse(new Uint8Array(docxBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(docxBuffer.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("DOCX generation error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
