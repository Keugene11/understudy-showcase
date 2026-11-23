import type { Adapter, Company, FieldType, FormField } from "./types";
import { field, getJson, getText, htmlToText, isRemote } from "./util";

type GhJob = { id: number; title: string; absolute_url: string; location?: { name?: string }; first_published?: string; updated_at?: string };
type GhField = { name: string; type: string; values?: { label: string; value: string | number }[] };
type GhQuestion = { label: string; description?: string | null; required: boolean; fields: GhField[] };
type GhDetail = GhJob & {
  content?: string;
  departments?: { name: string }[];
  questions?: GhQuestion[];
  location_questions?: GhQuestion[];
  compliance?: { type: string; questions: GhQuestion[] }[];
  demographic_questions?: { questions?: { id: number; label: string; required: boolean; type: string; answer_options?: { id: number; label: string }[] }[] } | null;
  /** "education_required" / "education_optional" / "education_not_required" — the only sign the form has an Education block. */
  education?: string;
};

/** Which parts of the Education block a board collects, and which it insists on. Each value is required/optional/hidden. */
type EducationConfig = Partial<Record<"school_name" | "degree" | "discipline" | "start_month" | "start_year" | "end_month" | "end_year", string>>;

const TYPE: Record<string, FieldType> = {
  input_text: "text",
  textarea: "textarea",
  input_file: "file",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
  input_hidden: "text",
};

function toFields(questions: GhQuestion[] | undefined, group?: FormField["group"]): FormField[] {
  const out: FormField[] = [];
  for (const q of questions ?? []) {
    // Resume/cover letter come as a file + "paste text" pair; keep only the file input.
    const fields = q.fields.some((f) => f.type === "input_file") ? q.fields.filter((f) => f.type === "input_file") : q.fields;
    for (const f of fields) {
      if (f.type === "input_hidden") continue;
      out.push(
        field({
          key: f.name,
          label: q.label,
          type: TYPE[f.type] ?? "text",
          required: q.required,
          description: q.description ? htmlToText(q.description) : undefined,
          options: f.values?.length ? f.values.map((v) => ({ label: v.label, value: String(v.value) })) : undefined,
          group,
        }),
      );
    }
  }
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Degree and discipline lists are per board and change about never; one fetch serves every job on that board. */
const listCache = new Map<string, { at: number; items: string[] }>();
async function educationList(slug: string, kind: "degrees" | "disciplines"): Promise<string[]> {
  const key = `${slug}/${kind}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.items;
  // Paged 100 at a time: page 1 alone ends at "Dietetics", so Psychology and Mathematics were never offered and a
  // Psychology M.A. could only be matched to the nearest early entry ("Biopsychology"). Every page, up to meta.total_count.
  const items: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const data = await getJson<{ items?: { text: string }[]; meta?: { total_count?: number; per_page?: number } }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/education/${kind}?page=${page}`).catch(() => null);
    const got = (data?.items ?? []).map((i) => i.text).filter(Boolean);
    items.push(...got);
    const total = data?.meta?.total_count ?? 0;
    if (!got.length || items.length >= total) break;
  }
  if (items.length) listCache.set(key, { at: Date.now(), items });
  return items;
}

/**
 * Greenhouse's Education block — School, Degree, Discipline and the education dates.
 *
 * None of it is in the question list `boards-api` returns, so no schema ever carried it, nothing answered it,
 * and the form refuses to submit with its required dropdowns still on "Select...": that is what killed SpaceX
 * ("Select... (Please fill out this field.)"), Together AI ("School is required.") and Stripe ("Start year is
 * required."). 36% of the Greenhouse postings we hold render this block and 26% require it.
 *
 * The API's only mention of it is the job's own `education` key. Which controls appear, and which are required,
 * is a per-board setting that the API doesn't expose at all — but the hosted form ships it server-rendered in
 * the page as `education_config`, right beside the controls it describes. Read it from there; if it can't be
 * read, carry nothing rather than guess a required field into the schema.
 *
 * Keys are the ids the form gives the controls ("school--0"), which is how the filler finds them.
 */
async function educationFields(c: Company, externalId: string): Promise<FormField[]> {
  const html = await getText(`https://job-boards.greenhouse.io/embed/job_app?for=${c.slug}&token=${externalId}`, 20_000).catch(() => "");
  const raw = html.match(/"education_config"\s*:\s*(\{[^}]*\})/)?.[1];
  let cfg: EducationConfig | null = null;
  try {
    cfg = raw ? (JSON.parse(raw) as EducationConfig) : null;
  } catch {
    cfg = null;
  }
  if (!cfg) return [];
  const shown = (k: keyof EducationConfig) => cfg[k] === "required" || cfg[k] === "optional";
  const req = (k: keyof EducationConfig) => cfg[k] === "required";
  const out: FormField[] = [];
  const add = (key: string, label: string, type: FieldType, required: boolean, options?: string[]) =>
    out.push(field({ key, label, type, required, group: "education", options: options?.map((o) => ({ label: o, value: o })) }));

  if (shown("school_name")) add("school--0", "School", "school", req("school_name"));
  if (shown("degree")) add("degree--0", "Degree", "select", req("degree"), await educationList(c.slug, "degrees"));
  if (shown("discipline")) add("discipline--0", "Discipline", "select", req("discipline"), await educationList(c.slug, "disciplines"));
  if (shown("start_month")) add("start-month--0", "Start date month", "select", req("start_month"), MONTHS);
  if (shown("start_year")) add("start-year--0", "Start date year", "number", req("start_year"));
  if (shown("end_month")) add("end-month--0", "End date month", "select", req("end_month"), MONTHS);
  if (shown("end_year")) add("end-year--0", "End date year", "number", req("end_year"));
  return out;
}

export const greenhouse: Adapter = {
  async list(c) {
    const data = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs`);
    return data.jobs.map((j) => ({
      externalId: String(j.id),
      title: j.title.trim(),
      location: j.location?.name?.trim() ?? "",
      remote: isRemote(j.location?.name, j.title),
      department: "",
      employmentType: "",
      salary: "",
      url: j.absolute_url,
      // The embeddable form never redirects to a company-hosted careers page (the /jobs/ URL often does).
      applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${c.slug}&token=${j.id}`,
      postedAt: j.first_published ?? j.updated_at ?? null,
    }));
  },
  async detail(c, job) {
    const d = await getJson<GhDetail>(`https://boards-api.greenhouse.io/v1/boards/${c.slug}/jobs/${job.externalId}?questions=true`);
    const eeo = (d.compliance ?? []).flatMap((block) => toFields(block.questions, "eeo"));
    // The hosted form asks "Are you Hispanic/Latino?" before Race (Race only appears after "No"), but the API omits it.
    const raceAt = eeo.findIndex((f) => f.key === "race");
    if (raceAt >= 0 && !eeo.some((f) => f.key === "hispanic_ethnicity")) {
      eeo.splice(raceAt, 0, field({ key: "hispanic_ethnicity", label: "Are you Hispanic/Latino?", type: "select", required: false, group: "eeo", options: ["Yes", "No", "Decline To Self Identify"].map((v) => ({ label: v, value: v })) }));
    }
    // The hosted form renders "location" as a city autocomplete (#candidate-location) and adds a phone-country picker the API doesn't list.
    const location = toFields(d.location_questions, "location").map((f) => (f.key === "location" ? { ...f, key: "candidate-location", type: "location" as const, standard: "location" as const } : f));
    const questions = toFields(d.questions, "custom");
    const phoneAt = questions.findIndex((f) => f.key === "phone");
    if (phoneAt >= 0) questions.splice(phoneAt, 0, field({ key: "country", label: "Country", type: "select", required: questions[phoneAt].required, standard: "country" }));
    // The Education block, which the API never lists. Only ~36% of postings have one, so only those pay for the
    // extra read of the form page. It renders straight after the resume, and goes in the schema there.
    if (d.education && d.education !== "education_not_required") {
      const education = await educationFields(c, job.externalId).catch(() => [] as FormField[]);
      const resumeAt = questions.findIndex((f) => f.standard === "resume");
      questions.splice(resumeAt >= 0 ? resumeAt + 1 : questions.length, 0, ...education);
    }
    const form = [
      ...questions,
      ...location,
      ...eeo,
      ...(d.demographic_questions?.questions ?? []).map((q) =>
        field({
          key: `demographic_${q.id}`,
          label: q.label,
          type: q.type.includes("multi_select") ? "multiselect" : "select",
          required: q.required,
          options: q.answer_options?.map((o) => ({ label: o.label, value: String(o.id) })),
          group: "eeo",
        }),
      ),
    ];
    const dept = d.departments?.map((x) => x.name).join(", ");
    return { description: (dept ? `Department: ${dept}\n\n` : "") + htmlToText(d.content ?? ""), form };
  },
  applyUrl: (c, job) => job.applyUrl || `https://job-boards.greenhouse.io/embed/job_app?for=${c.slug}&token=${job.externalId}`,
};
