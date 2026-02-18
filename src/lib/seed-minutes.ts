// Seed data placeholder — customize for Piscataway Township

export const SEED_ORDINANCE_TRACKING: {
  email_id: string;
  ordinance_number: string | null;
  introduction_date: string | null;
  hearing_date: string | null;
  hearing_amended: number;
  hearing_notes: string;
  adoption_date: string | null;
  adoption_vote: string | null;
  adoption_failed: number;
  clerk_notes: string;
}[] = [];

export const SEED_MINUTES: {
  meeting_type: string;
  meeting_date: string;
  video_url: string;
  minutes: string;
}[] = [];
