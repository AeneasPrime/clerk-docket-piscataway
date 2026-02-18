import { FEB10_MINUTES } from "./seed-minutes-feb10";

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
}[] = [
  {
    meeting_type: "council",
    meeting_date: "2026-02-10",
    video_url: "https://www.youtube.com/watch?v=dGFMOGPMHIc",
    minutes: FEB10_MINUTES,
  },
];
