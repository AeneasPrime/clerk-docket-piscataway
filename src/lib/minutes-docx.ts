import {
  Document,
  Paragraph,
  TextRun,
  AlignmentType,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  TabStopPosition,
  TabStopType,
} from "docx";
import { Packer } from "docx";

interface MinutesDocxOptions {
  meetingDate: string;
  meetingType: "council" | "reorganization";
  minutes: string;
  isDraft?: boolean;
}

function formatHeaderDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${m}/${d}/${y}`;
}

function formatLongDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00");
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length === 0) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.7;
}

function isFullWidthLine(text: string): boolean {
  return (
    text.startsWith("A Worksession") ||
    text.startsWith("A Regular") ||
    text.startsWith("A Combined") ||
    text.startsWith("A Council") ||
    text.startsWith("Present were") ||
    text.startsWith("Also present") ||
    text.startsWith("The Township Clerk advised") ||
    text.startsWith("This meeting") ||
    text.startsWith("http") ||
    text.startsWith("On a motion") ||
    text.startsWith("Hearing no further")
  );
}

function isCenteredLine(text: string): boolean {
  return /^RESOLUTION\s+#/.test(text);
}

function isBoldLine(text: string, inDiscussion: boolean): boolean {
  if (isAllCaps(text)) return true;
  if (inDiscussion) {
    if (text.startsWith("Councilmember") || text.startsWith("Council President") ||
        text.startsWith("Council Vice President")) return true;
    if (/^a\.\s/.test(text)) return true;
  }
  return false;
}

const REVIEW_RE = /\[REVIEW:\s*(.*?)(?:\s*@\d{1,2}:\d{2}(?::\d{2})?)?\s*\]/g;

function hasReviewMarker(text: string): boolean {
  return /\[REVIEW:[^\]]*\]/.test(text);
}

/** Build TextRun array for a line, rendering [REVIEW:] markers in red */
function buildTextRuns(text: string, bold?: boolean): TextRun[] {
  if (!hasReviewMarker(text)) {
    return [new TextRun({ text, bold, font: "Times New Roman", size: 20 })];
  }

  const runs: TextRun[] = [];
  const regex = new RegExp(REVIEW_RE.source, "g");
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({
        text: text.slice(lastIndex, match.index),
        bold,
        font: "Times New Roman",
        size: 20,
      }));
    }
    runs.push(new TextRun({
      text: `REVIEW: ${match[1]}`,
      bold,
      font: "Times New Roman",
      size: 20,
      color: "CC0000",
    }));
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    runs.push(new TextRun({
      text: text.slice(lastIndex),
      bold,
      font: "Times New Roman",
      size: 20,
    }));
  }
  return runs;
}

// Twip conversions (1 inch = 1440 twips, 1pt = 20 twips)
const SECTION_INDENT = 720; // 36pt = 720 twips (0.5 inch)
const BULLET_INDENT = 360; // 18pt = 360 twips (0.25 inch)
const SUB_BULLET_INDENT = 720; // 36pt = 720 twips (0.5 inch)

export async function generateMinutesDocx(options: MinutesDocxOptions): Promise<Buffer> {
  const { meetingDate, minutes, isDraft } = options;
  const headerDate = formatHeaderDate(meetingDate);

  const lines = minutes.replace(/\t/g, "    ").split("\n");

  // Find title block end
  let titleEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("A Worksession") || t.startsWith("A Regular") || t.startsWith("A Combined")) {
      titleEnd = i;
      break;
    }
  }

  const titleLines = lines.slice(0, titleEnd).filter(l => l.trim().length > 0);

  // Find signature block
  let sigStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("___")) {
      sigStart = i;
      break;
    }
  }

  const bodyLines = lines.slice(titleEnd, sigStart);
  const sigLines = lines.slice(sigStart);

  const paragraphs: Paragraph[] = [];

  // --- Title block (centered, bold) ---
  paragraphs.push(new Paragraph({ spacing: { before: 240 } })); // blank line
  for (const line of titleLines) {
    paragraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: line.trim(), bold: true, font: "Times New Roman", size: 20 })],
      spacing: { line: 220 },
    }));
  }
  paragraphs.push(new Paragraph({ spacing: { before: 240 } })); // blank line

  // --- Body ---
  const sectionNumPattern = /^(\d+)\.\s+/;
  let insideSection = false;
  let inDiscussion = false;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      paragraphs.push(new Paragraph({ spacing: { line: 220 } }));
      continue;
    }

    // Centered lines (RESOLUTION #)
    if (isCenteredLine(trimmed)) {
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: trimmed, bold: true, font: "Times New Roman", size: 20 })],
        spacing: { before: 120, line: 220 },
      }));
      continue;
    }

    // Bullet points
    if (trimmed.startsWith("•") || trimmed.startsWith("○")) {
      const isSub = trimmed.startsWith("○");
      const indent = isSub ? SUB_BULLET_INDENT : BULLET_INDENT;
      paragraphs.push(new Paragraph({
        indent: { left: indent },
        children: buildTextRuns(trimmed),
        spacing: { line: 220 },
      }));
      continue;
    }

    // Track Discussion Items section
    if (/^\d+\.\s+DISCUSSION/.test(trimmed)) {
      inDiscussion = true;
    } else if (/^\d+\.\s+/.test(trimmed) && !trimmed.includes("DISCUSSION")) {
      inDiscussion = false;
    }

    const sectionMatch = trimmed.match(sectionNumPattern);

    if (sectionMatch) {
      // Numbered section header
      insideSection = true;
      paragraphs.push(new Paragraph({
        spacing: { before: 120, line: 220 },
        indent: { left: SECTION_INDENT, hanging: SECTION_INDENT },
        children: [new TextRun({ text: trimmed, bold: true, font: "Times New Roman", size: 20 })],
      }));
    } else if (insideSection && !isFullWidthLine(trimmed)) {
      // Indented content within a section
      const bold = isBoldLine(trimmed, inDiscussion);
      paragraphs.push(new Paragraph({
        indent: { left: SECTION_INDENT },
        children: buildTextRuns(trimmed, bold),
        spacing: { line: 220 },
      }));
    } else {
      // Full-width text
      if (trimmed.startsWith("On a motion")) insideSection = false;
      if (trimmed.startsWith("Hearing no further")) insideSection = false;

      if (hasReviewMarker(trimmed)) {
        paragraphs.push(new Paragraph({
          children: buildTextRuns(trimmed),
          spacing: { line: 220 },
        }));
      } else {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: trimmed, font: "Times New Roman", size: 20 })],
          spacing: { line: 220 },
        }));
      }
    }
  }

  // --- Signature block ---
  const nameLinesParsed: string[] = [];
  const titleLinesParsed: string[] = [];
  for (const line of sigLines) {
    const t = line.trim();
    if (t.includes("___") || t === "") continue;
    if (nameLinesParsed.length < 2) {
      const parts = t.split(/\s{4,}/);
      if (parts.length >= 2) {
        nameLinesParsed.push(parts[0].trim(), parts[1].trim());
      } else {
        nameLinesParsed.push(t);
      }
    } else {
      const parts = t.split(/\s{4,}/);
      if (parts.length >= 2) {
        titleLinesParsed.push(parts[0].trim(), parts[1].trim());
      } else {
        titleLinesParsed.push(t);
      }
    }
  }

  paragraphs.push(new Paragraph({ spacing: { before: 480 } })); // space before sigs

  const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const topBorder = { style: BorderStyle.SINGLE, size: 1, color: "000000" };

  // Signature table: two columns with name/title under lines
  const sigTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 45, type: WidthType.PERCENTAGE },
            borders: { top: topBorder, bottom: noBorder, left: noBorder, right: noBorder },
            children: [new Paragraph({
              children: [new TextRun({
                text: nameLinesParsed[0] || "TBD Council President",
                font: "Times New Roman", size: 20,
              })],
            })],
          }),
          new TableCell({
            width: { size: 10, type: WidthType.PERCENTAGE },
            borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
            children: [new Paragraph({})],
          }),
          new TableCell({
            width: { size: 45, type: WidthType.PERCENTAGE },
            borders: { top: topBorder, bottom: noBorder, left: noBorder, right: noBorder },
            children: [new Paragraph({
              children: [new TextRun({
                text: nameLinesParsed[1] || "TBD Municipal Clerk",
                font: "Times New Roman", size: 20,
              })],
            })],
          }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({
            width: { size: 45, type: WidthType.PERCENTAGE },
            borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
            children: [new Paragraph({
              children: [new TextRun({
                text: titleLinesParsed[0] || "Council President",
                font: "Times New Roman", size: 20,
              })],
            })],
          }),
          new TableCell({
            width: { size: 10, type: WidthType.PERCENTAGE },
            borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
            children: [new Paragraph({})],
          }),
          new TableCell({
            width: { size: 45, type: WidthType.PERCENTAGE },
            borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
            children: [new Paragraph({
              children: [new TextRun({
                text: titleLinesParsed[1] || "Municipal Clerk",
                font: "Times New Roman", size: 20,
              })],
            })],
          }),
        ],
      }),
    ],
  });

  paragraphs.push(sigTable as unknown as Paragraph); // will add separately

  // Build header/footer
  const headerChildren: TextRun[] = [];
  if (isDraft) {
    headerChildren.push(new TextRun({
      text: "DRAFT",
      bold: true,
      font: "Times New Roman",
      size: 56,
      color: "CC0000",
    }));
    headerChildren.push(new TextRun({
      text: "\t",
      font: "Times New Roman",
      size: 20,
    }));
  }
  headerChildren.push(new TextRun({
    text: isDraft ? headerDate : `\t${headerDate}`,
    font: "Times New Roman",
    size: 20,
  }));

  // Assemble document — separate paragraphs and table for sections children
  const sectionChildren: (Paragraph | Table)[] = [];
  for (const p of paragraphs) {
    if (p instanceof Table) {
      sectionChildren.push(p);
    } else {
      sectionChildren.push(p);
    }
  }
  // Remove the sigTable that was pushed as Paragraph and add as Table properly
  sectionChildren.pop(); // remove the cast
  sectionChildren.push(sigTable);

  const doc = new Document({
    title: `Council Meeting Minutes - ${formatLongDate(meetingDate)}`,
    creator: "Township of Piscataway Municipal Clerk",
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // 8.5 x 11 in twips
          margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }, // 1 inch margins
          pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            tabStops: [
              { type: TabStopType.CENTER, position: TabStopPosition.MAX / 2 },
              { type: TabStopType.RIGHT, position: 9360 }, // right edge (8.5" - 2" margins = 6.5" = 9360 twips)
            ],
            children: headerChildren,
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({
              children: [PageNumber.CURRENT],
              font: "Times New Roman",
              size: 20,
            })],
          })],
        }),
      },
      children: sectionChildren,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}
