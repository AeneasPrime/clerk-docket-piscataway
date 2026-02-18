import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { ClassificationResult, DocketEntry, DocketStatus, Meeting, MeetingStatus, OrdinanceTracking } from "@/types";
import { SEED_MINUTES, SEED_ORDINANCE_TRACKING } from "./seed-minutes";

const dbPath = process.env.DATABASE_PATH || "./data/docket.db";
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS docket (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT UNIQUE NOT NULL,
    email_from TEXT NOT NULL,
    email_subject TEXT NOT NULL,
    email_date TEXT NOT NULL,
    email_body_preview TEXT NOT NULL,
    relevant INTEGER NOT NULL DEFAULT 0,
    confidence TEXT,
    item_type TEXT,
    department TEXT,
    summary TEXT,
    extracted_fields TEXT NOT NULL DEFAULT '{}',
    completeness TEXT NOT NULL DEFAULT '{}',
    attachment_filenames TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT NOT NULL DEFAULT '',
    target_meeting_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS processed_emails (
    email_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_docket_status ON docket(status);
  CREATE INDEX IF NOT EXISTS idx_docket_item_type ON docket(item_type);
  CREATE INDEX IF NOT EXISTS idx_docket_relevant ON docket(relevant);
  CREATE INDEX IF NOT EXISTS idx_docket_created_at ON docket(created_at);

  CREATE TABLE IF NOT EXISTS docket_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    docket_id INTEGER NOT NULL REFERENCES docket(id),
    field_name TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_docket_history_docket ON docket_history(docket_id);

  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_type TEXT NOT NULL CHECK(meeting_type IN ('council', 'reorganization')),
    meeting_date TEXT NOT NULL,
    meeting_time TEXT NOT NULL DEFAULT '7:00 PM',
    cycle_date TEXT NOT NULL,
    video_url TEXT,
    agenda_url TEXT,
    minutes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'in_progress', 'completed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_type_date ON meetings(meeting_type, meeting_date);
  CREATE INDEX IF NOT EXISTS idx_meetings_cycle ON meetings(cycle_date);

  CREATE TABLE IF NOT EXISTS minutes_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_minutes_history_meeting ON minutes_history(meeting_id);

  CREATE TABLE IF NOT EXISTS ordinance_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    docket_id INTEGER NOT NULL UNIQUE REFERENCES docket(id) ON DELETE CASCADE,
    ordinance_number TEXT,
    introduction_date TEXT,
    introduction_meeting TEXT,
    pub_intro_date TEXT,
    pub_intro_newspaper TEXT,
    bulletin_posted_date TEXT,
    hearing_date TEXT,
    hearing_amended INTEGER DEFAULT 0,
    hearing_notes TEXT DEFAULT '',
    adoption_date TEXT,
    adoption_vote TEXT,
    adoption_failed INTEGER DEFAULT 0,
    pub_final_date TEXT,
    pub_final_newspaper TEXT,
    effective_date TEXT,
    is_emergency INTEGER DEFAULT 0,
    website_posted_date TEXT,
    website_url TEXT,
    clerk_notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ord_tracking_docket ON ordinance_tracking(docket_id);
`);

// --- Migrations ---
try { db.prepare("SELECT text_override FROM docket LIMIT 0").get(); }
catch { db.exec("ALTER TABLE docket ADD COLUMN text_override TEXT"); }
try { db.prepare("SELECT meeting_time FROM meetings LIMIT 0").get(); }
catch { db.exec("ALTER TABLE meetings ADD COLUMN meeting_time TEXT NOT NULL DEFAULT '7:00 PM'"); }

// Piscataway Township 2026 Council Meeting Schedule (defined early for seedDemoData)
const PISCATAWAY_2026_SCHEDULE: { date: string; time: string; type: "council" | "reorganization" }[] = [
  { date: "2026-01-02", time: "6:00 PM", type: "reorganization" },
  { date: "2026-01-20", time: "7:00 PM", type: "council" },
  { date: "2026-02-10", time: "7:00 PM", type: "council" },
  { date: "2026-03-12", time: "6:45 PM", type: "council" },
  { date: "2026-04-14", time: "7:00 PM", type: "council" },
  { date: "2026-05-14", time: "6:45 PM", type: "council" },
  { date: "2026-06-11", time: "6:45 PM", type: "council" },
  { date: "2026-06-30", time: "7:00 PM", type: "council" },
  { date: "2026-07-21", time: "7:00 PM", type: "council" },
  { date: "2026-08-11", time: "7:00 PM", type: "council" },
  { date: "2026-09-01", time: "7:00 PM", type: "council" },
  { date: "2026-10-06", time: "7:00 PM", type: "council" },
  { date: "2026-11-05", time: "6:45 PM", type: "council" },
  { date: "2026-11-12", time: "6:45 PM", type: "council" },
  { date: "2026-11-24", time: "7:00 PM", type: "council" },
  { date: "2026-12-01", time: "7:00 PM", type: "council" },
  { date: "2026-12-08", time: "7:00 PM", type: "council" },
  { date: "2026-12-15", time: "7:00 PM", type: "council" },
];

// --- Seed demo data (runs lazily on first API call, not during build) ---
let _seeded = false;
export function ensureSeeded(): void {
  if (_seeded) return;
  _seeded = true;
  seedDemoData();
}

// --- Config ---

export function getConfig(key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

// --- Processed emails ---

export function isEmailProcessed(emailId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM processed_emails WHERE email_id = ?")
    .get(emailId);
  return !!row;
}

export function markEmailProcessed(emailId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO processed_emails (email_id) VALUES (?)"
  ).run(emailId);
}

// --- Docket entries ---

export function createDocketEntry(params: {
  emailId: string;
  emailFrom: string;
  emailSubject: string;
  emailDate: string;
  emailBodyPreview: string;
  classification: ClassificationResult;
  attachmentFilenames: string[];
}): number {
  const { classification } = params;
  const result = db
    .prepare(
      `INSERT INTO docket (
        email_id, email_from, email_subject, email_date, email_body_preview,
        relevant, confidence, item_type, department, summary,
        extracted_fields, completeness, attachment_filenames
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.emailId,
      params.emailFrom,
      params.emailSubject,
      params.emailDate,
      params.emailBodyPreview,
      classification.relevant ? 1 : 0,
      classification.confidence,
      classification.item_type,
      classification.department,
      classification.summary,
      JSON.stringify(classification.extracted_fields),
      JSON.stringify(classification.completeness),
      JSON.stringify(params.attachmentFilenames)
    );
  const docketId = result.lastInsertRowid as number;

  // Auto-create ordinance tracking for ordinance items
  if (classification.item_type === "ordinance_new" || classification.item_type === "ordinance_amendment") {
    const ef = classification.extracted_fields;
    const tracking: Record<string, string | number | null> = {};

    // Extract ordinance number: from classifier, or parse from attachment filename (e.g. "O.2271-2026_Adopt_Area.pdf")
    const ordNum = ef.ordinance_number ?? null;
    if (ordNum) {
      tracking.ordinance_number = ordNum;
    } else {
      const match = params.attachmentFilenames
        .map((f) => f.match(/^(O\.\d+-\d{4})/i))
        .find((m) => m);
      if (match) tracking.ordinance_number = match[1];
    }

    // Determine reading stage and populate dates
    const stage = ef.reading_stage ?? null;
    if (stage === "first") {
      // First reading — email date is roughly the introduction date
      tracking.introduction_date = params.emailDate;
    } else if (stage === "second") {
      // Second reading — the hearing is happening at the target meeting
      tracking.introduction_date = params.emailDate; // Approximate — clerk can refine
    }

    if (Object.keys(tracking).length > 0) {
      upsertOrdinanceTracking(docketId, tracking);
    } else {
      // Create empty tracking record so it shows up in the ordinances view
      upsertOrdinanceTracking(docketId, {});
    }
  }

  return docketId;
}

export function getDocketEntries(filters?: {
  status?: DocketStatus;
  relevant?: boolean;
  itemType?: string;
  limit?: number;
  offset?: number;
}): { entries: DocketEntry[]; total: number } {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (filters?.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters?.relevant !== undefined) {
    conditions.push("relevant = ?");
    values.push(filters.relevant ? 1 : 0);
  }
  if (filters?.itemType) {
    conditions.push("item_type = ?");
    values.push(filters.itemType);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const total = db
    .prepare(`SELECT COUNT(*) as count FROM docket ${where}`)
    .get(...values) as { count: number };

  const entries = db
    .prepare(
      `SELECT * FROM docket ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as DocketEntry[];

  return { entries, total: total.count };
}

export function getDocketEntry(id: number): DocketEntry | null {
  const row = db.prepare("SELECT * FROM docket WHERE id = ?").get(id) as
    | DocketEntry
    | undefined;
  return row ?? null;
}

export function getDocketEntryByEmailId(emailId: string): DocketEntry | null {
  const row = db.prepare("SELECT * FROM docket WHERE email_id = ?").get(emailId) as
    | DocketEntry
    | undefined;
  return row ?? null;
}

export function updateDocketEntry(
  id: number,
  updates: {
    status?: DocketStatus;
    notes?: string;
    target_meeting_date?: string | null;
    item_type?: string;
    department?: string;
    text_override?: string | null;
  }
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.notes !== undefined) {
    sets.push("notes = ?");
    values.push(updates.notes);
  }
  if (updates.target_meeting_date !== undefined) {
    sets.push("target_meeting_date = ?");
    values.push(updates.target_meeting_date);
  }
  if (updates.item_type !== undefined) {
    sets.push("item_type = ?");
    values.push(updates.item_type);
  }
  if (updates.department !== undefined) {
    sets.push("department = ?");
    values.push(updates.department);
  }
  if (updates.text_override !== undefined) {
    sets.push("text_override = ?");
    values.push(updates.text_override);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE docket SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
    id
  );
}

export function insertDocketHistory(
  docketId: number,
  fieldName: string,
  oldValue: string,
  newValue: string
): void {
  db.prepare(
    "INSERT INTO docket_history (docket_id, field_name, old_value, new_value) VALUES (?, ?, ?, ?)"
  ).run(docketId, fieldName, oldValue, newValue);
}

export function getDocketHistory(docketId: number): {
  id: number;
  docket_id: number;
  field_name: string;
  old_value: string;
  new_value: string;
  changed_at: string;
}[] {
  return db
    .prepare("SELECT * FROM docket_history WHERE docket_id = ? ORDER BY changed_at DESC")
    .all(docketId) as {
    id: number;
    docket_id: number;
    field_name: string;
    old_value: string;
    new_value: string;
    changed_at: string;
  }[];
}

export function getDocketStats(): {
  total: number;
  new_count: number;
  reviewed: number;
  accepted: number;
  needs_info: number;
  by_type: { item_type: string; count: number }[];
  by_department: { department: string; count: number }[];
} {
  const total = db
    .prepare("SELECT COUNT(*) as count FROM docket WHERE relevant = 1")
    .get() as { count: number };

  const statusCounts = db
    .prepare(
      "SELECT status, COUNT(*) as count FROM docket WHERE relevant = 1 GROUP BY status"
    )
    .all() as { status: string; count: number }[];

  const statusMap: Record<string, number> = {};
  for (const row of statusCounts) {
    statusMap[row.status] = row.count;
  }

  const byType = db
    .prepare(
      "SELECT item_type, COUNT(*) as count FROM docket WHERE relevant = 1 AND item_type IS NOT NULL GROUP BY item_type ORDER BY count DESC"
    )
    .all() as { item_type: string; count: number }[];

  const byDepartment = db
    .prepare(
      "SELECT department, COUNT(*) as count FROM docket WHERE relevant = 1 AND department IS NOT NULL GROUP BY department ORDER BY count DESC"
    )
    .all() as { department: string; count: number }[];

  return {
    total: total.count,
    new_count: statusMap["new"] || 0,
    reviewed: statusMap["reviewed"] || 0,
    accepted: statusMap["accepted"] || 0,
    needs_info: statusMap["needs_info"] || 0,
    by_type: byType,
    by_department: byDepartment,
  };
}

// --- Meetings ---

export function ensureMeetingsGenerated(): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO meetings (meeting_type, meeting_date, meeting_time, cycle_date) VALUES (?, ?, ?, ?)`
  );

  const txn = db.transaction(() => {
    for (const mtg of PISCATAWAY_2026_SCHEDULE) {
      insert.run(mtg.type, mtg.date, mtg.time, mtg.date);
    }
  });
  txn();
}

export function getMeetings(filters?: {
  filter?: "upcoming" | "past" | "all";
  limit?: number;
  offset?: number;
}): { meetings: Meeting[]; total: number } {
  const now = new Date().toISOString().split("T")[0];
  let condition = "";
  const values: string[] = [];

  if (filters?.filter === "upcoming") {
    condition = "WHERE meeting_date >= ?";
    values.push(now);
  } else if (filters?.filter === "past") {
    condition = "WHERE meeting_date < ?";
    values.push(now);
  }

  const limit = filters?.limit ?? 30;
  const offset = filters?.offset ?? 0;

  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM meetings ${condition}`
  ).get(...values) as { count: number };

  const orderDir = filters?.filter === "past" ? "DESC" : "ASC";
  const rows = db.prepare(
    `SELECT * FROM meetings ${condition} ORDER BY meeting_date ${orderDir} LIMIT ? OFFSET ?`
  ).all(...values, limit, offset) as Meeting[];

  return { meetings: rows, total: totalRow.count };
}

export function getMeeting(id: number): Meeting | null {
  const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Meeting | undefined;
  return row ?? null;
}

export function getMeetingByTypeAndDate(meetingType: string, meetingDate: string): Meeting | null {
  const row = db.prepare(
    "SELECT * FROM meetings WHERE meeting_type = ? AND meeting_date = ?"
  ).get(meetingType, meetingDate) as Meeting | undefined;
  return row ?? null;
}

export function getMeetingsByDate(meetingDate: string): Meeting[] {
  return db.prepare(
    "SELECT * FROM meetings WHERE meeting_date = ?"
  ).all(meetingDate) as Meeting[];
}

export function updateMeeting(
  id: number,
  updates: { video_url?: string | null; agenda_url?: string | null; minutes?: string; status?: MeetingStatus }
): void {
  const sets: string[] = [];
  const values: (string | null)[] = [];

  if (updates.video_url !== undefined) {
    sets.push("video_url = ?");
    values.push(updates.video_url);
  }
  if (updates.agenda_url !== undefined) {
    sets.push("agenda_url = ?");
    values.push(updates.agenda_url);
  }
  if (updates.minutes !== undefined) {
    sets.push("minutes = ?");
    values.push(updates.minutes);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");

  db.prepare(`UPDATE meetings SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
}

export function insertMinutesHistory(
  meetingId: number,
  oldValue: string,
  newValue: string
): void {
  db.prepare(
    "INSERT INTO minutes_history (meeting_id, old_value, new_value) VALUES (?, ?, ?)"
  ).run(meetingId, oldValue, newValue);
}

export function getMinutesHistory(meetingId: number): {
  id: number;
  meeting_id: number;
  old_value: string;
  new_value: string;
  changed_at: string;
}[] {
  return db
    .prepare("SELECT * FROM minutes_history WHERE meeting_id = ? ORDER BY changed_at DESC")
    .all(meetingId) as {
    id: number;
    meeting_id: number;
    old_value: string;
    new_value: string;
    changed_at: string;
  }[];
}

export function getAgendaItemsForMeeting(meetingDate: string): DocketEntry[] {
  return db.prepare(
    `SELECT * FROM docket WHERE target_meeting_date = ? AND status IN ('accepted', 'on_agenda') ORDER BY item_type, id`
  ).all(meetingDate) as DocketEntry[];
}

/** Find past meetings that have video_url but no minutes yet */
export function getMeetingsNeedingMinutes(): Meeting[] {
  const today = new Date().toISOString().split("T")[0];
  return db.prepare(`
    SELECT * FROM meetings
    WHERE video_url IS NOT NULL
      AND (minutes IS NULL OR minutes = '')
      AND meeting_date <= ?
    ORDER BY meeting_date ASC
  `).all(today) as Meeting[];
}

/** Find all past meetings with video URLs that have no minutes yet (no agenda item requirement) */
export function getPastMeetingsWithoutMinutes(): Meeting[] {
  const today = new Date().toISOString().split("T")[0];
  return db.prepare(`
    SELECT * FROM meetings
    WHERE video_url IS NOT NULL
      AND (minutes IS NULL OR minutes = '')
      AND meeting_date <= ?
    ORDER BY meeting_date ASC
  `).all(today) as Meeting[];
}

/** Find all past meetings that have no video URL yet */
export function getPastMeetingsWithoutVideo(): Meeting[] {
  const today = new Date().toISOString().split("T")[0];
  return db.prepare(`
    SELECT * FROM meetings
    WHERE (video_url IS NULL OR video_url = '')
      AND meeting_date <= ?
    ORDER BY meeting_date ASC
  `).all(today) as Meeting[];
}

// --- Ordinance Lifecycle Helpers ---

/** Find the next council meeting that is at least `minDaysAfter` days after `afterDate`. */
export function getNextCouncilMeetingAfter(afterDate: string, minDaysAfter = 10): Meeting | null {
  const earliest = new Date(afterDate + "T12:00:00");
  earliest.setDate(earliest.getDate() + minDaysAfter);
  const earliestStr = earliest.toISOString().split("T")[0];

  // Ensure meetings are generated
  ensureMeetingsGenerated();

  const row = db.prepare(
    `SELECT * FROM meetings WHERE meeting_type = 'council' AND meeting_date >= ? ORDER BY meeting_date ASC LIMIT 1`
  ).get(earliestStr) as Meeting | undefined;
  return row ?? null;
}

// --- Ordinance Tracking ---

export function getOrdinanceTracking(docketId: number): OrdinanceTracking | null {
  const row = db.prepare("SELECT * FROM ordinance_tracking WHERE docket_id = ?").get(docketId) as OrdinanceTracking | undefined;
  return row ?? null;
}

export function upsertOrdinanceTracking(
  docketId: number,
  updates: Partial<Omit<OrdinanceTracking, "id" | "docket_id" | "created_at" | "updated_at">>
): void {
  const existing = getOrdinanceTracking(docketId);
  if (!existing) {
    // Insert with provided fields
    const cols = ["docket_id"];
    const placeholders = ["?"];
    const vals: (string | number | null)[] = [docketId];
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        cols.push(k);
        placeholders.push("?");
        vals.push(v as string | number | null);
      }
    }
    db.prepare(`INSERT INTO ordinance_tracking (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`).run(...vals);
  } else {
    // Update existing
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v as string | number | null);
      }
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE ordinance_tracking SET ${sets.join(", ")} WHERE docket_id = ?`).run(...vals, docketId);
  }
}

export function getAllOrdinancesWithTracking(): (DocketEntry & { tracking: OrdinanceTracking | null })[] {
  const ordinances = db.prepare(`
    SELECT * FROM docket
    WHERE item_type IN ('ordinance_new', 'ordinance_amendment')
    ORDER BY created_at DESC
  `).all() as DocketEntry[];

  return ordinances.map((ord) => {
    let tracking = getOrdinanceTracking(ord.id);

    // Lazy-create tracking for existing ordinances that don't have it yet
    if (!tracking) {
      const autoFields: Record<string, string | number | null> = {};

      // Try to parse ordinance number from attachment filenames
      try {
        const files = JSON.parse(ord.attachment_filenames) as string[];
        const match = files.map((f) => f.match(/^(O\.\d+-\d{4})/i)).find((m) => m);
        if (match) autoFields.ordinance_number = match[1];
      } catch { /* ignore */ }

      // Try to get ordinance number from extracted_fields
      try {
        const ef = JSON.parse(ord.extracted_fields);
        if (ef.ordinance_number) autoFields.ordinance_number = ef.ordinance_number;
      } catch { /* ignore */ }

      // Use target_meeting_date as introduction date if available
      if (ord.target_meeting_date) {
        autoFields.introduction_date = ord.target_meeting_date;
      }

      upsertOrdinanceTracking(ord.id, autoFields);
      tracking = getOrdinanceTracking(ord.id);
    }

    return { ...ord, tracking };
  });
}

// --- Seed demo data ---

function seedDemoData() {
  // Ensure meeting rows exist before seeding minutes into them
  ensureMeetingsGenerated();

  // Seed minutes for demo meetings (idempotent — only updates meetings with no minutes)
  const seededMinutes = db.prepare("SELECT value FROM config WHERE key = 'seed_minutes_v3'").get() as { value: string } | undefined;
  if (!seededMinutes) {
    db.prepare("INSERT INTO config (key, value) VALUES ('seed_minutes_v3', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    for (const m of SEED_MINUTES) {
      const meeting = db.prepare("SELECT id, minutes FROM meetings WHERE meeting_date = ? AND meeting_type = ?").get(m.meeting_date, m.meeting_type) as { id: number; minutes: string } | undefined;
      if (meeting && !meeting.minutes) {
        db.prepare("UPDATE meetings SET minutes = ?, video_url = ?, status = 'completed' WHERE id = ?").run(m.minutes, m.video_url, meeting.id);
        console.log(`[seed] Seeded minutes for ${m.meeting_date} ${m.meeting_type}`);
      }
    }
  }

  // Mark general seed as done
  const seeded = db.prepare("SELECT value FROM config WHERE key = 'seed_v1'").get() as { value: string } | undefined;
  if (!seeded) {
    db.prepare("INSERT INTO config (key, value) VALUES ('seed_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    console.log("[seed] Piscataway instance initialized");
  }
}

/* Original seed data removed — Piscataway instance starts clean */
/*
    // === JAN 20, 2026 COUNCIL MEETING (7:00 PM) ===
    ["Fischer, James <fischer@piscatawaynj.org>", "Administrative Agenda - Mayor Wahler Appointments January 2026", "2026-01-08",
      "Mayor's appointments and administrative items a. through m. for the January 20 council meeting.", 1,
      "other", "Administration", "Mayor Wahler administrative agenda items a. through m. — board and commission appointments",
      {}, ["Admin_Agenda_012026.pdf"], "on_agenda", "2026-01-20"],

    ["Caruso, Thomas <caruso@piscatawaynj.org>", "Ordinance Amending §39-12.15 Technical Review Committee", "2026-01-07",
      "Amendment to Chapter 39 Land Use, §39-12.15 Technical Review Committee to streamline application review.", 1,
      "ordinance_amendment", "Law", "Amendment to Land Use code §39-12.15 redesigning Technical Review Committee",
      { statutory_citation: "N.J.S.A. 40:55D-1 et seq." },
      ["Ordinance_TechReview.pdf"], "on_agenda", "2026-01-20"],

    ["Caruso, Thomas <caruso@piscatawaynj.org>", "Ordinance Amending Article V - Boards, Commissions, Committees", "2026-01-07",
      "Amendment to Article V of Chapter 2 Administration updating boards, commissions, committees structure.", 1,
      "ordinance_amendment", "Law", "Amendment to Chapter 2 Administration — boards, commissions organizational structure",
      {}, ["Ordinance_BoardsCommissions.pdf"], "on_agenda", "2026-01-20"],

    ["Santos-Rivera, Elena <santos-rivera@piscatawaynj.org>", "Business Administrator Items a. through u. - January 20", "2026-01-08",
      "Business Administrator's items a. through u. including contracts, change orders, and authorizations.", 1,
      "other", "Administration", "Business Administrator agenda items a. through u. — contracts and authorizations",
      {}, ["BA_Items_012026.pdf"], "on_agenda", "2026-01-20"],

    ["Council President <lombardi@piscatawaynj.org>", "Presentation - 250th Anniversary of Our Country", "2026-01-06",
      "America 250th Anniversary presentation. Council President Lombardi will read statement re: Piscataway's colonial heritage.", 1,
      "discussion_item", "Administration", "Council President Lombardi presentation on America 250th Anniversary",
      {}, ["America250_Statement.pdf"], "on_agenda", "2026-01-20"],

    ["Marchetti, Frank <marchetti@piscatawaynj.org>", "Report of Disbursements through January 8, 2026", "2026-01-09",
      "Report of Disbursements for the period ending January 8, 2026.", 1,
      "resolution_disbursement", "Finance/CFO", "Report of disbursements through January 8, 2026",
      {}, ["Disbursement_Report_010826.pdf"], "on_agenda", "2026-01-20"],

    ["Tax Collection <taxcollector@piscatawaynj.org>", "Tax Refund Authorization - January 2026", "2026-01-09",
      "Tax overpayments requiring refund. Total: $12,447.30 across 9 properties.", 1,
      "resolution_tax_refund", "Tax Collection", "Authorization of tax refund overpayments totaling $12,447.30",
      { contract_amount: "$12,447.30" },
      ["Tax_Refund_List_Jan2026.pdf"], "on_agenda", "2026-01-20"],

    ["IT Department <it@piscatawaynj.org>", "Edmunds & Associates - Software Maintenance and Hosting Renewal", "2026-01-09",
      "Annual renewal of Edmunds GovTech financial management system for Finance, Tax, and Utility Billing.", 1,
      "resolution_state_contract", "Finance/CFO", "Annual renewal of Edmunds GovTech financial management system",
      { vendor_name: "Edmunds & Associates, Inc." },
      ["Edmunds_Renewal_Quote_2026.pdf"], "on_agenda", "2026-01-20"],

    ["IT Department <it@piscatawaynj.org>", "Johnston Communications - IT Infrastructure and Fiber Optic Network", "2026-01-08",
      "Contract with Johnston Communications for IT infrastructure, fiber optic network, and Avaya phone support.", 1,
      "resolution_professional_services", "Administration", "IT infrastructure contract with Johnston Communications for fiber optic and network services",
      { vendor_name: "Johnston GP, Inc. d/b/a Johnston Communications", vendor_address: "36 Commerce Street, Springfield, NJ 07081" },
      ["Johnston_Proposal_2026.pdf"], "on_agenda", "2026-01-20"],

    ["Recreation Dept <recreation@piscatawaynj.org>", "AD Cafe - Promotional Items, Trophies and Awards Contract", "2026-01-09",
      "Public Bid #25-01-18 for promotional items, trophies and awards. NTE $32,000.00.", 1,
      "resolution_bid_award", "Recreation", "Bid award to AD Cafe for promotional items, trophies and awards, NTE $32,000",
      { vendor_name: "AD Cafe", contract_amount: "$32,000.00", bid_number: "Public Bid #25-01-18" },
      ["Bid_25-01-18_Tabulation.pdf"], "on_agenda", "2026-01-20"],

    ["Clerk's Office <clerk@piscatawaynj.org>", "GMA Marketing / Minuteman Press - Printing Services Contract", "2026-01-08",
      "Contract with Minuteman Press for printing — agenda packets, public hearing notices, municipal forms. NTE $10,000.", 1,
      "resolution_bid_award", "Administration", "Printing services contract with Minuteman Press, NTE $10,000",
      { vendor_name: "GMA Marketing Inc. d/b/a Minuteman Press", contract_amount: "$10,000.00" },
      ["Minuteman_Press_Quote.pdf"], "on_agenda", "2026-01-20"],

    // === FEB 10, 2026 COUNCIL MEETING (7:00 PM) — actual agenda ===
    ["Mayor's Office <mayor@piscatawaynj.org>", "Proclamation - Black History Month", "2026-02-03",
      "Proclamation recognizing February 2026 as Black History Month in Piscataway Township.", 1,
      "proclamation", "Administration", "Proclamation recognizing Black History Month",
      {}, [], "on_agenda", "2026-02-10"],

    ["Seader, Melissa <clerk@piscatawaynj.org>", "Ordinance Second Reading - Chapter 7 Traffic - Parking Prohibited at All Times", "2026-02-03",
      "Ordinance amending Chapter 7 Traffic, Section 14 - Parking Prohibited at All Times On Certain Streets. Second reading and public hearing.", 1,
      "ordinance", "Administration", "Second reading of ordinance amending Ch. 7 Traffic Sec. 14 - Parking Prohibited at All Times on Certain Streets",
      { ordinance_section: "Chapter 7, Section 14" }, ["Ord_Ch7_Sec14_Parking.pdf"], "on_agenda", "2026-02-10"],

    ["Seader, Melissa <clerk@piscatawaynj.org>", "Ordinance Second Reading - Chapter 4 Hotels and Motels Licensing", "2026-02-03",
      "Ordinance adding Chapter 4 Licensing and Business Regulations, Section 16, Hotels and Motels. Second reading and public hearing.", 1,
      "ordinance", "Administration", "Second reading of ordinance adding Ch. 4 Licensing Sec. 16 - Hotels and Motels",
      { ordinance_section: "Chapter 4, Section 16" }, ["Ord_Ch4_Sec16_Hotels.pdf"], "on_agenda", "2026-02-10"],

    ["Engineering Dept <engineering@piscatawaynj.org>", "Change Order #1 - 2025-2026 Sidewalk Repair Program - Messercola Excavating", "2026-02-02",
      "Authorizing Change Order #1 to include curbs, driveways & handicap ramps. Messercola Excavating. Not to exceed $43,760.00.", 1,
      "resolution_bid_award", "Engineering", "Change Order #1 for sidewalk repair program to include curbs/driveways/ramps - Messercola Excavating, NTE $43,760",
      { vendor_name: "Messercola Excavating", contract_amount: "$43,760.00" }, ["ChangeOrder1_Sidewalk.pdf"], "on_agenda", "2026-02-10"],

    ["Purchasing <purchasing@piscatawaynj.org>", "Purchases from NJ State Contract and Cooperative Vendors", "2026-02-03",
      "Resolution authorizing purchases from various NJ State Contract and approved cooperative vendors.", 1,
      "resolution_state_contract", "Administration", "Authorization for purchases from NJ State Contract and cooperative vendors",
      {}, [], "on_agenda", "2026-02-10"],

    ["Risk Management <riskmanagement@piscatawaynj.org>", "Central Jersey Joint Insurance Fund - 2026 Safety Incentive Program", "2026-02-01",
      "Resolution adopting Central Jersey Joint Insurance Fund 2026 Safety Incentive Program.", 1,
      "resolution", "Administration", "Adoption of Central Jersey Joint Insurance Fund 2026 Safety Incentive Program",
      {}, [], "on_agenda", "2026-02-10"],

    ["Seader, Melissa <clerk@piscatawaynj.org>", "2026 Amusement License - Circle Bowl & Entertainment", "2026-02-03",
      "Authorizing 2026 Amusement License for Circle Stelton Holding Company, LLC t/a Circle Bowl & Entertainment.", 1,
      "license", "Administration", "2026 Amusement License for Circle Bowl & Entertainment",
      { vendor_name: "Circle Stelton Holding Company, LLC" }, [], "on_agenda", "2026-02-10"],

    ["IT Department <it@piscatawaynj.org>", "Award of Contract - Piscataway SAN Upgrade via TIPS USA - Cxtec", "2026-02-04",
      "Award of contract through TIPS USA for Storage Area Network (SAN) upgrade for backup, DR, and production servers. Cxtec. NTE $194,680.00.", 1,
      "resolution_bid_award", "Administration", "SAN upgrade for backup/DR/production servers - Cxtec via TIPS USA, NTE $194,680",
      { vendor_name: "Cxtec", contract_amount: "$194,680.00" }, ["Cxtec_SAN_Quote.pdf"], "on_agenda", "2026-02-10"],

    ["Planning Dept <planning@piscatawaynj.org>", "Harbor Consultants - Affordable Housing Professional Services", "2026-02-02",
      "Award of contract for affordable housing professional services. Harbor Consultants Inc. Not to exceed $88,000.00.", 1,
      "resolution_professional_services", "Planning", "Affordable housing professional services - Harbor Consultants, NTE $88,000",
      { vendor_name: "Harbor Consultants Inc.", contract_amount: "$88,000.00" }, ["Harbor_Consultants_Proposal.pdf"], "on_agenda", "2026-02-10"],

    ["Library <library@piscatawaynj.org>", "OverDrive Inc. - Two Year Contract for Non-Print Materials", "2026-02-01",
      "Two year contract with OverDrive, Inc. for non-print materials for Piscataway Township Library. Not to exceed $85,000.00.", 1,
      "resolution_bid_award", "Library", "2-year contract with OverDrive for library non-print materials, NTE $85,000",
      { vendor_name: "OverDrive, Inc.", contract_amount: "$85,000.00" }, ["OverDrive_Contract.pdf"], "on_agenda", "2026-02-10"],

    ["Library <library@piscatawaynj.org>", "STELLA Consortium - Two Year Library Automation Services Contract", "2026-02-01",
      "Two year contract with STELLA Consortium for Library Automation Services. Not to exceed $230,000.00.", 1,
      "resolution_bid_award", "Library", "2-year contract with STELLA Consortium for library automation services, NTE $230,000",
      { vendor_name: "STELLA Consortium", contract_amount: "$230,000.00" }, ["STELLA_Contract.pdf"], "on_agenda", "2026-02-10"],

    ["Recreation Dept <recreation@piscatawaynj.org>", "FY2026 Local Recreation Improvement Grant - Riverside Park Field Lighting", "2026-02-02",
      "Authorizing submission of FY2026 Local Recreation Improvement Grant application to NJ DCA for Riverside Park field lighting system upgrades.", 1,
      "resolution", "Recreation", "FY2026 NJ DCA grant application for Riverside Park field lighting upgrades",
      {}, ["Grant_Application_RiversidePark.pdf"], "on_agenda", "2026-02-10"],

    ["Planning Dept <planning@piscatawaynj.org>", "Commitment to Fourth Round Housing Element Zoning Changes", "2026-02-03",
      "Resolution committing to adoption of ordinances and resolutions implementing zoning changes following resolution of challenge to Fourth Round Housing Element and Fair Share Plan.", 1,
      "resolution", "Planning", "Commitment to adopt zoning changes per Fourth Round Housing Element and Fair Share Plan",
      {}, [], "on_agenda", "2026-02-10"],

    ["Engineering Dept <engineering@piscatawaynj.org>", "Orris Avenue Road Improvements - Grotto Engineering", "2026-02-02",
      "Award of professional services contract for Orris Avenue road improvements. Grotto Engineering. Not to exceed $40,423.13.", 1,
      "resolution_professional_services", "Engineering", "Professional services for Orris Ave road improvements - Grotto Engineering, NTE $40,423.13",
      { vendor_name: "Grotto Engineering", contract_amount: "$40,423.13" }, ["Grotto_Orris_Proposal.pdf"], "on_agenda", "2026-02-10"],

    ["Tax Assessor <assessor@piscatawaynj.org>", "Professional Appraisal Services - Tax Appeals - Sterling DiSanto & Associates", "2026-02-03",
      "Award of contract for professional appraisal services for tax appeals and commercial property valuation. Sterling DiSanto & Associates. NTE $35,000.00.", 1,
      "resolution_professional_services", "Tax Assessment", "Tax appeals appraisal services - Sterling DiSanto & Associates, NTE $35,000",
      { vendor_name: "Sterling DiSanto & Associates", contract_amount: "$35,000.00" }, ["SterlingDiSanto_Proposal.pdf"], "on_agenda", "2026-02-10"],

    ["Engineering Dept <engineering@piscatawaynj.org>", "2025 Road Program - Curbs, Sidewalks and ADA Ramps - KM Construction Corp.", "2026-02-04",
      "Award of bid for 2025 Road Program for curbs, sidewalks and ADA ramps. KM Construction Corp. Not to exceed $2,244,782.10.", 1,
      "resolution_bid_award", "Engineering", "2025 Road Program curbs/sidewalks/ADA ramps - KM Construction, NTE $2,244,782.10",
      { vendor_name: "KM Construction Corp.", contract_amount: "$2,244,782.10" }, ["KM_Construction_Bid.pdf"], "on_agenda", "2026-02-10"],

    ["Administration <admin@piscatawaynj.org>", "RFP for Redevelopment, Affordable Housing and PILOT Financial Advisory", "2026-02-03",
      "Resolution authorizing advertising of RFP for redevelopment, affordable housing and PILOT financial advisory services.", 1,
      "resolution", "Administration", "Authorization to advertise RFP for redevelopment/affordable housing/PILOT advisory services",
      {}, [], "on_agenda", "2026-02-10"],

    ["Engineering Dept <engineering@piscatawaynj.org>", "Return of Cash Performance Bond - 521 Stelton Road - Equity Land Group", "2026-02-02",
      "Return of cash performance bond for Equity Land Group, LLC - Block 5302, Lot 1.01, 521 Stelton Road, off-site improvements (20-ZB-09/10V).", 1,
      "resolution_bond_release", "Engineering", "Return of cash performance bond - Equity Land Group, 521 Stelton Rd",
      { block_lot: "Block 5302, Lot 1.01" }, ["Bond_Release_521Stelton.pdf"], "on_agenda", "2026-02-10"],

    ["Administration <admin@piscatawaynj.org>", "Transfer of Block 2101, Lot 11.03 - 73 Old New Brunswick Road", "2026-02-01",
      "Resolution authorizing transfer of Block 2101, Lot 11.03 located at 73 Old New Brunswick Road.", 1,
      "resolution", "Administration", "Transfer of Block 2101, Lot 11.03 at 73 Old New Brunswick Road",
      { block_lot: "Block 2101, Lot 11.03" }, [], "on_agenda", "2026-02-10"],

    // === MAR 12, 2026 COUNCIL MEETING (6:45 PM) ===
    ["Caruso, Thomas <caruso@piscatawaynj.org>", "Ordinance - Chapter 7 Traffic - Electric Scooter Regulations", "2026-01-28",
      "Proposed ordinance creating Subchapter 7-44 Electric Scooter Regulations. Helmet requirements, lighting, penalties.", 1,
      "ordinance_new", "Law", "New ordinance creating Subchapter 7-44 regulating electric scooter operation",
      { statutory_citation: "N.J.S.A. 39:4-14.16 et seq." },
      ["O.2270-2026_Electric_Scooter.pdf"], "on_agenda", "2026-03-12"],

    ["Caruso, Thomas <caruso@piscatawaynj.org>", "Ordinance Amending Chapter 23 - Adopt an Area Program Guidelines", "2026-01-29",
      "Proposed ordinance amending Chapter 23 Adopt an Area Program to update guidelines and expand eligibility.", 1,
      "ordinance_amendment", "Law", "Amendment to Chapter 23 Adopt an Area Program — updated guidelines, expanded eligibility",
      {}, ["O.2271-2026_Adopt_Area.pdf"], "on_agenda", "2026-03-12"],

    ["Engineering Dept <engineering@piscatawaynj.org>", "J. Fletcher Creamer & Son - Smart Hydrant Leak Detection Installation", "2026-02-03",
      "Contract to J. Fletcher Creamer & Son for Smart Hydrant Leak Detection on 350 hydrants. Bid #25-10-22. $2,311,200.00.", 1,
      "resolution_bid_award", "Engineering", "Smart hydrant leak detection installation on 350 hydrants, $2,311,200",
      { vendor_name: "J. Fletcher Creamer & Son, Inc.", contract_amount: "$2,311,200.00", bid_number: "Public Bid #25-10-22" },
      ["Creamer_Bid_Response.pdf", "Bid_Tabulation_25-10-22.pdf"], "on_agenda", "2026-03-12"],

    ["Engineering Dept <engineering@piscatawaynj.org>", "Plainfield Avenue Water Main Replacement Project", "2026-02-03",
      "Plainfield Avenue Water Main Replacement — 2,400 LF of 8-inch ductile iron pipe. Amount: $474,850.00.", 1,
      "resolution_bid_award", "Engineering", "Plainfield Avenue water main replacement — 2,400 LF, $474,850",
      { contract_amount: "$474,850.00" },
      ["Plainfield_WaterMain_BidTab.pdf"], "on_agenda", "2026-03-12"],

    ["Santos-Rivera, Elena <santos-rivera@piscatawaynj.org>", "Emergency Water Main Repair Services - B&W Construction Co.", "2026-02-03",
      "Emergency water main repair services. Bid No. 25-10-23. B&W Construction secondary vendor. NTE $2,000,000/year.", 1,
      "resolution_bid_award", "Water/Sewer Utility", "Emergency water main repair services with B&W Construction, NTE $2M/year",
      { vendor_name: "B&W Construction Co. of NJ, Inc.", contract_amount: "$2,000,000.00/year", bid_number: "Public Bid No. 25-10-23" },
      ["Bid_25-10-23_Tabulation.pdf"], "on_agenda", "2026-03-12"],

    ["Human Resources <hr@piscatawaynj.org>", "MOA - United Steel Workers Local 1426 Contract Agreement", "2026-02-04",
      "Memorandum of Agreement with USW Local 1426 for 2025-2028 term. Requires council ratification.", 1,
      "resolution_personnel", "Human Resources", "Memorandum of Agreement with USW Local 1426 for 2025-2028 contract term",
      { vendor_name: "United Steel Workers International Union, AFL-CIO, Local 1426" },
      ["MOA_USW_Local1426_2025-2028.pdf", "Fiscal_Impact_Statement.pdf"], "on_agenda", "2026-03-12"],

    ["Recreation Dept <recreation@piscatawaynj.org>", "Penn Jersey Paper Co - Kitchen Equipment Purchase and Installation", "2026-02-04",
      "Kitchen equipment purchase at Community Center from Penn Jersey Paper Co LLC.", 1,
      "resolution_bid_award", "Recreation", "Kitchen equipment at Community Center from Penn Jersey Paper Co",
      { vendor_name: "Penn Jersey Paper Co LLC" },
      ["PennJersey_Quote.pdf"], "on_agenda", "2026-03-12"],

    ["Tax Collection <taxcollector@piscatawaynj.org>", "Sewer Overpayment Refunds - February 2026", "2026-02-04",
      "Sewer overpayments requiring refund authorization. Total: $9,385.93 across 8 accounts.", 1,
      "resolution_tax_refund", "Tax Collection", "Authorization of sewer overpayment refunds totaling $9,385.93",
      { contract_amount: "$9,385.93" },
      ["Sewer_Refund_List_Feb2026.pdf"], "on_agenda", "2026-03-12"],

    // === UNASSIGNED (in queue) ===
    ["Caruso, Thomas <caruso@piscatawaynj.org>", "Ordinance Amending Chapter 25 Trees - Running Bamboo Prohibition", "2026-02-05",
      "Proposed ordinance to prohibit planting and spread of running bamboo in the Township.", 1,
      "ordinance_amendment", "Law", "Amendment to Chapter 25 Trees — prohibiting running bamboo",
      {}, ["Ordinance_Bamboo.pdf"], "reviewed", null],

    ["Morales, Rafael <morales@piscatawaynj.org>", "Ordinance to Exceed Municipal Budget Appropriation Limits - Cap Bank", "2026-02-06",
      "Annual ordinance to exceed budget appropriation limits and establish cap bank per N.J.S.A. 40A:4-45.14.", 1,
      "ordinance_new", "Finance/CFO", "Annual cap bank ordinance — must be adopted before 2026 budget introduction",
      { statutory_citation: "N.J.S.A. 40A:4-45.14" },
      ["Ordinance_CapBank_2026.pdf"], "reviewed", null],

    ["Public Works <dpw@piscatawaynj.org>", "Plumbing Services Contract - Various Vendors", "2026-02-06",
      "Plumbing services contracts for township building maintenance. Multiple vendors. NTE $75,000.", 1,
      "resolution_bid_award", "Public Works", "Plumbing services contracts for township buildings, NTE $75,000",
      { contract_amount: "$75,000.00" },
      ["Plumbing_Services_Vendors.pdf"], "new", null],

    ["Engineering Dept <engineering@piscatawaynj.org>", "Street Opening Escrow - 111 Livingston Avenue", "2026-02-07",
      "Street opening escrow $4,800 for utility work at 111 Livingston Ave. PSE&G gas main connection.", 1,
      "resolution_escrow_release", "Engineering", "Street opening escrow of $4,800 for utility work at 111 Livingston Ave",
      { escrow_amount: "$4,800.00", block_lot: "111 Livingston Avenue" },
      ["Street_Opening_Application.pdf"], "new", null],

    ["Fischer, James <fischer@piscatawaynj.org>", "Community Heritage Grant - Piscataway Historical Society", "2026-02-05",
      "Transfer of Community Heritage Grant from NJ Historical Commission. NTE $250,000 for Piscataway Historical Museum.", 1,
      "resolution_grant", "Administration", "Transfer of $250,000 Community Heritage Grant for Piscataway Historical Museum",
      { contract_amount: "$250,000.00", vendor_name: "Piscataway Historical Society" },
      ["Heritage_Grant_Agreement.pdf"], "accepted", null],

    ["Engineering Dept <engineering@piscatawaynj.org>", "LiRo Engineers - DPW Garage Design and Construction Documents", "2026-02-06",
      "Professional services for DPW Garage design, engineering, and construction document preparation.", 1,
      "resolution_professional_services", "Engineering", "LiRo Engineers for DPW Garage design and construction documents",
      { vendor_name: "LiRo Engineers, Inc.", statutory_citation: "N.J.S.A. 40A:11-5(1)(a)(i)" },
      ["LiRo_DPW_Garage_Proposal.pdf"], "new", null],

    ["Tax Collection <taxcollector@piscatawaynj.org>", "Tax Sale Certificate Redemption Report - January 2026", "2026-02-02",
      "Monthly report of tax sale certificates redeemed in January 2026.", 1,
      "resolution_tax_sale_redemption", "Tax Collection", "Monthly report of tax sale certificates redeemed in January 2026",
      {}, ["TaxSale_Redemption_Jan2026.pdf"], "accepted", null],

    // Non-relevant
    ["Piscataway Chamber of Commerce <info@piscatawaychamber.com>", "2026 Piscataway Chamber Annual Gala - Sponsorship Opportunities", "2026-02-03",
      "2026 Piscataway Chamber Annual Gala on March 14 at the Pines Manor. Sponsorship levels $500 to $5,000.", 0,
      "other", "Administration", "Chamber of Commerce gala sponsorship solicitation — not council business",
      {}, ["Gala_Sponsorship_Flyer.pdf"], "new", null],

    ["GovDeals <notifications@govdeals.com>", "New Surplus Equipment Available in Your Area", "2026-02-04",
      "New government surplus items available near Piscataway, NJ. Browse heavy equipment, vehicles, office furniture.", 0,
      "other", "Administration", "Government surplus marketplace notification — automated marketing email",
      {}, [], "new", null],
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO docket (
      email_id, email_from, email_subject, email_date, email_body_preview,
      relevant, confidence, item_type, department, summary,
      extracted_fields, completeness, attachment_filenames,
      status, notes, target_meeting_date
    ) VALUES (?, ?, ?, ?, ?, ?, 'high', ?, ?, ?, ?, '{}', ?, ?, '', ?)
  `);

  const pStmt = db.prepare("INSERT OR IGNORE INTO processed_emails (email_id) VALUES (?)");

  const insertAll = db.transaction(() => {
    for (const [from, subject, date, body, relevant, itemType, dept, summary, fields, attachments, status, meetingDate] of rows) {
      const emailId = `seed-${date}-${subject.slice(0, 40).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`;
      stmt.run(emailId, from, subject, date, body, relevant, itemType, dept, summary,
        JSON.stringify(fields), JSON.stringify(attachments), status, meetingDate);
      pStmt.run(emailId);
    }
  });

  insertAll();

  // Seed meetings with video URLs and generated minutes
  try {
    // Ensure meeting rows exist first
    ensureMeetingsGenerated();
    const meetingInsert = db.prepare(
      `INSERT OR IGNORE INTO meetings (meeting_type, meeting_date, meeting_time, cycle_date) VALUES (?, ?, ?, ?)`
    );
    const meetingUpdate = db.prepare(`
      UPDATE meetings SET video_url = ?, minutes = ?, status = 'completed'
      WHERE meeting_date = ? AND meeting_type = ?
    `);
    const seedMeetings = db.transaction(() => {
      for (const m of SEED_MINUTES) {
        meetingInsert.run(m.meeting_type, m.meeting_date, "7:00 PM", m.meeting_date);
        meetingUpdate.run(m.video_url, m.minutes, m.meeting_date, m.meeting_type);
      }
    });
    seedMeetings();
    console.log(`[seed] Seeded ${SEED_MINUTES.length} meetings with minutes`);
  } catch (e) {
    console.warn("[seed] Could not load seed-minutes:", e);
  }

  // Seed agenda URLs (official township PDFs)
  const agendaUrls: { date: string; type: string; url: string }[] = [
    { date: "2026-02-10", type: "council", url: "https://cms9files.revize.com/piscatawaytownshipnj/Document_Center/Government/Meeting%20Information/Township%20Council/Agendas/2026/02.10.26%20Council%20meeting%20agenda.pdf" },
  ];
  const agendaUpdate = db.prepare(`UPDATE meetings SET agenda_url = ? WHERE meeting_date = ? AND meeting_type = ?`);
  for (const a of agendaUrls) {
    agendaUpdate.run(a.url, a.date, a.type);
  }

  // Seed ordinance tracking data
  try {
    const ordUpsert = db.prepare(`
      INSERT INTO ordinance_tracking (docket_id, ordinance_number, introduction_date, hearing_date, hearing_amended, hearing_notes, adoption_date, adoption_vote, adoption_failed, clerk_notes)
      SELECT d.id, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM docket d WHERE d.email_id = ?
      ON CONFLICT(docket_id) DO UPDATE SET
        ordinance_number = excluded.ordinance_number,
        introduction_date = excluded.introduction_date,
        hearing_date = excluded.hearing_date,
        hearing_amended = excluded.hearing_amended,
        hearing_notes = excluded.hearing_notes,
        adoption_date = excluded.adoption_date,
        adoption_vote = excluded.adoption_vote,
        adoption_failed = excluded.adoption_failed,
        clerk_notes = excluded.clerk_notes
    `);
    const seedOrdinances = db.transaction(() => {
      for (const o of SEED_ORDINANCE_TRACKING) {
        ordUpsert.run(
          o.ordinance_number, o.introduction_date, o.hearing_date,
          o.hearing_amended, o.hearing_notes, o.adoption_date,
          o.adoption_vote, o.adoption_failed, o.clerk_notes, o.email_id
        );
      }
    });
    seedOrdinances();
    console.log(`[seed] Seeded ${SEED_ORDINANCE_TRACKING.length} ordinance tracking records`);
  } catch (e) {
    console.warn("[seed] Could not seed ordinance tracking:", e);
  }

  db.prepare("INSERT INTO config (key, value) VALUES ('seed_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  console.log(`[seed] Inserted ${rows.length} demo docket entries`);
*/
