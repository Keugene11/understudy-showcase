export type Ats = "greenhouse" | "lever" | "ashby" | "workable" | "smartrecruiters" | "recruitee" | "workday" | "rippling" | "google" | "meta" | "avature" | ListOnlyAts;

/** Boards we read for the public job lists but can't apply through (src/lib/ats/listonly.ts). */
export type ListOnlyAts = "oracle" | "icims" | "eightfold" | "jibe" | "amazon" | "apple";
// Oracle Recruiting left this list on 27 Oct: extension/oracle.js sends its applications (a step driver, like Workday's).
// Amazon left it the same day: extension/amazon.js signs in to Amazon Jobs and walks its application.
// Eightfold (Microsoft, Qualcomm, Netflix, Eaton …) left it too: extension/eightfold.js signs in (a mailed code) and fills its one-page form.
// Apple (jobs.apple.com) was never on it: crawled, matched and sent by extension/apple.js from the start.
// iCIMS portals (careers-<employer>.icims.com: SAS, Rambus, Stifel, Peraton…) left it on 27 Oct too: extension/icims.js.
export const LIST_ONLY: ListOnlyAts[] = ["jibe"];
/**
 * The iCIMS portals the driver has been walked through to the last step (dry runs, 27 Oct). Every portal brings its own
 * profile questions and disclosure forms, and the first untried one (Peraton) stopped on a ticked signature, so only
 * these are matched and sent; the other ~30 crawled iCIMS boards stay list-only until a dry run gets through them.
 * Hosts, as in companies.extra.host (= the slug).
 */
export const ICIMS_VETTED = ["careers-sas.icims.com", "careers-rambus.icims.com", "careers-peraton.icims.com"];
/** Whether a job on this board can be applied to: not a list-only board, and an iCIMS portal only once vetted. */
export const canApplyOn = (ats: string, host: string) => !(LIST_ONLY as string[]).includes(ats) && (ats !== "icims" || ICIMS_VETTED.includes(host.toLowerCase()));

export const ATS_LABEL: Record<Ats, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  smartrecruiters: "SmartRecruiters",
  recruitee: "Recruitee",
  workday: "Workday",
  rippling: "Rippling",
  oracle: "Oracle Recruiting",
  icims: "iCIMS",
  eightfold: "Eightfold",
  jibe: "iCIMS (Jibe)",
  amazon: "Amazon Jobs",
  google: "Google Careers",
  apple: "Apple Jobs",
  meta: "Meta Careers",
  avature: "Avature",
};

/**
 * Jibe (AMD, Intercontinental Exchange, Susquehanna, DocuSign, Rivian, Keysight, Aon …) is only a job-search front end:
 * every one of its ~34 boards sends Apply to an iCIMS portal (<tenant>.icims.com/jobs/<id>/login, the posting's
 * applyUrl; 2,238 of 2,238 open postings on 27 Oct), and Jibe has no application form of its own. So a Jibe posting is
 * an iCIMS application, recorded as one (its driver, pauses, triage, accounts).
 * Jibe stays list-only for now (27 Oct): iCIMS sends only on vetted portals (ICIMS_VETTED), none of the Jibe tenants
 * (AMD, ICE, SIG, DocuSign…) is vetted yet. Take "jibe" off
 * LIST_ONLY once one of their portals has passed a dry run and is in ICIMS_VETTED.
 */
export const applyAts = (ats: string) => (ats === "jibe" ? "icims" : ats);

/** `jobs_hash` is what the board's openings looked like last crawl, so an unchanged board writes nothing. */
export type Company = { id: number; ats: Ats; slug: string; name: string; extra: Record<string, string>; jobs_hash?: string | null; capped_at?: string | Date | null };

export type RawJob = {
  externalId: string;
  title: string;
  location: string;
  remote: boolean;
  department: string;
  employmentType: string;
  salary: string;
  url: string;
  applyUrl: string;
  postedAt: string | null;
};

/**
 * What `list` returns. `truncated` means the board had more openings than the adapter read (Workday stops at its
 * newest 200), so a posting missing from it is not proof that it closed; see `closeScopeFor` in close-scope.ts.
 */
export type Listing = RawJob[] & {
  truncated?: boolean;
  /**
   * What a crawl may close, when the listing is more than one newest-first read: the list-only boards add title
   * searches to their newest 200 (listonly.ts), and only that first read says anything about what closed.
   */
  scope?: unknown; // CloseScope in the full repo
  /**
   * The adapter left postings out of this read on purpose (Meta: each posting's date is read from its own page, a
   * few hundred per crawl). The read is saved but not remembered as settled, so the next crawl reads the board again.
   */
  pending?: boolean;
};

/**
 * `school` is a dropdown backed by the board's own institution list (Greenhouse's Education block). It can't be
 * filled like an ordinary select — the list is thousands of entries long, it is searched over the network, and
 * it spells schools its own way ("State University of New York at Buffalo" for "University at Buffalo") —
 * so the filler drives it with a search of its own rather than by matching options.
 */
export type FieldType = "text" | "textarea" | "email" | "phone" | "url" | "number" | "date" | "file" | "select" | "multiselect" | "boolean" | "location" | "school";

/** Well-known fields we can fill from the profile without asking the model. */
export type StandardKey =
  | "first_name"
  | "last_name"
  | "full_name"
  | "preferred_name"
  | "email"
  | "phone"
  | "location"
  | "resume"
  | "cover_letter"
  | "linkedin"
  | "github"
  | "website"
  | "portfolio"
  | "twitter"
  | "current_company"
  | "current_title"
  | "country";

export type FormField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  description?: string;
  options?: { label: string; value: string }[];
  standard?: StandardKey;
  /**
   * eeo = voluntary self-identification; these are answered from the profile's EEO settings, never by the model.
   * education = a board's own Education block (school, degree, field of study, dates), answered from the resume's
   * education by rule — never by the model, which has no business inventing a school or a degree.
   */
  group?: "eeo" | "location" | "custom" | "education";
};

/**
 * `applyUrl`: where the application really lives, when the detail call knows better than the listing did.
 * SmartRecruiters' apply page is keyed on the posting's uuid, which a reposted job changes.
 */
/** `title` / `location` / `remote`: what a posting fetched by itself (a pasted link the crawl never listed) knows about itself, so the row isn't "Job at <company>". */
export type JobDetail = { description: string; form: FormField[] | null; applyUrl?: string; title?: string; location?: string; remote?: boolean };

export type Adapter = {
  list(c: Company): Promise<RawJob[]>;
  detail(c: Company, job: { externalId: string; url: string }): Promise<JobDetail>;
  /** Where a human (or the extension) fills the application. */
  applyUrl(c: Company, job: { externalId: string; url: string; applyUrl: string }): string;
};
