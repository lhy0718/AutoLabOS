export type CollectSortField = "relevance" | "citationCount" | "publicationDate" | "paperId";
export type CollectSortOrder = "asc" | "desc";
export type BibtexMode = "generated" | "s2" | "hybrid";

export interface CollectSort {
  field: CollectSortField;
  order: CollectSortOrder;
}

export interface CollectFilters {
  lastYears?: number;
  year?: string;
  dateRange?: string;
  fieldsOfStudy?: string[];
  venues?: string[];
  publicationTypes?: string[];
  minCitationCount?: number;
  openAccessPdf?: boolean;
}

export interface CollectCommandRequest {
  query?: string;
  runQuery?: string;
  limit?: number;
  additional?: number;
  filters: CollectFilters;
  sort: CollectSort;
  bibtexMode: BibtexMode;
  dryRun: boolean;
  warnings: string[];
}

export interface CollectParseResult {
  ok: boolean;
  request?: CollectCommandRequest;
  errors: string[];
  usage: string;
}

const SORT_FIELDS: CollectSortField[] = [
  "relevance",
  "citationCount",
  "publicationDate",
  "paperId"
];
const SORT_ORDERS: CollectSortOrder[] = ["asc", "desc"];
const BIBTEX_MODES: BibtexMode[] = ["generated", "s2", "hybrid"];

const YEAR_SPEC_RE = /^(\d{4}|(\d{4}-\d{4})|(\d{4}-)|(-\d{4}))$/;
const DATE_PART_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export const COLLECT_USAGE =
  "Usage: /agent collect [query] [--run <run>] [--limit <n>|--additional <n>] [--last-years <n>|--year <spec>|--date-range <start:end>] [--sort <relevance|citationCount|publicationDate|paperId>] [--order <asc|desc>] [--field <csv>] [--venue <csv>] [--type <csv>] [--min-citations <n>] [--open-access] [--bibtex <generated|s2|hybrid>] [--dry-run]";

export function parseCollectArgs(input: string[] | string): CollectParseResult {
  const args = Array.isArray(input) ? input : tokenizeQuotedArgs(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  const positionals: string[] = [];

  let runQuery: string | undefined;
  let limit: number | undefined;
  let additional: number | undefined;
  let lastYears: number | undefined;
  let year: string | undefined;
  let dateRange: string | undefined;
  let sortField: CollectSortField = "relevance";
  let sortOrder: CollectSortOrder | undefined;
  let fieldsOfStudy: string[] | undefined;
  let venues: string[] | undefined;
  let publicationTypes: string[] | undefined;
  let minCitationCount: number | undefined;
  let openAccessPdf = false;
  let bibtexMode: BibtexMode = "hybrid";
  let dryRun = false;

  let idx = 0;
  while (idx < args.length) {
    const token = args[idx];
    idx += 1;

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    switch (token) {
      case "--run": {
        const next = args[idx];
        if (!next) {
          errors.push("Missing value for --run");
          break;
        }
        runQuery = next;
        idx += 1;
        break;
      }
      case "--limit": {
        const parsed = readPositiveInt(args[idx]);
        if (parsed === undefined) {
          errors.push("Invalid --limit value. Use a positive integer.");
          break;
        }
        limit = parsed;
        idx += 1;
        break;
      }
      case "--additional": {
        const parsed = readPositiveInt(args[idx]);
        if (parsed === undefined) {
          errors.push("Invalid --additional value. Use a positive integer.");
          break;
        }
        additional = parsed;
        idx += 1;
        break;
      }
      case "--last-years": {
        const parsed = readPositiveInt(args[idx]);
        if (parsed === undefined) {
          errors.push("Invalid --last-years value. Use a positive integer.");
          break;
        }
        lastYears = parsed;
        idx += 1;
        break;
      }
      case "--year": {
        const next = args[idx];
        if (!next || !YEAR_SPEC_RE.test(next)) {
          errors.push("Invalid --year value. Expected YYYY, YYYY-YYYY, YYYY-, -YYYY.");
          break;
        }
        year = next;
        idx += 1;
        break;
      }
      case "--date-range": {
        const next = args[idx];
        if (!next || !isValidDateRange(next)) {
          errors.push("Invalid --date-range value. Expected <start:end>.");
          break;
        }
        dateRange = next;
        idx += 1;
        break;
      }
      case "--sort": {
        const next = args[idx] as CollectSortField | undefined;
        if (!next || !SORT_FIELDS.includes(next)) {
          errors.push("Invalid --sort value.");
          break;
        }
        sortField = next;
        idx += 1;
        break;
      }
      case "--order": {
        const next = args[idx] as CollectSortOrder | undefined;
        if (!next || !SORT_ORDERS.includes(next)) {
          errors.push("Invalid --order value. Use asc or desc.");
          break;
        }
        sortOrder = next;
        idx += 1;
        break;
      }
      case "--field": {
        const next = args[idx];
        if (!next) {
          errors.push("Missing value for --field.");
          break;
        }
        fieldsOfStudy = parseCsv(next);
        idx += 1;
        break;
      }
      case "--venue": {
        const next = args[idx];
        if (!next) {
          errors.push("Missing value for --venue.");
          break;
        }
        venues = parseCsv(next);
        idx += 1;
        break;
      }
      case "--type": {
        const next = args[idx];
        if (!next) {
          errors.push("Missing value for --type.");
          break;
        }
        publicationTypes = parseCsv(next);
        idx += 1;
        break;
      }
      case "--min-citations": {
        const parsed = readPositiveInt(args[idx]);
        if (parsed === undefined) {
          errors.push("Invalid --min-citations value. Use a positive integer.");
          break;
        }
        minCitationCount = parsed;
        idx += 1;
        break;
      }
      case "--open-access":
        openAccessPdf = true;
        break;
      case "--bibtex": {
        const next = args[idx] as BibtexMode | undefined;
        if (!next || !BIBTEX_MODES.includes(next)) {
          errors.push("Invalid --bibtex value. Use generated, s2, or hybrid.");
          break;
        }
        bibtexMode = next;
        idx += 1;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      default:
        errors.push(`Unknown collect option: ${token}`);
    }
  }

  if (limit !== undefined && additional !== undefined) {
    errors.push("--limit and --additional cannot be used together.");
  }

  if (dateRange && year) {
    warnings.push("Both --date-range and --year were provided. --date-range takes precedence.");
    year = undefined;
  }
  if (dateRange && lastYears !== undefined) {
    warnings.push("Both --date-range and --last-years were provided. --date-range takes precedence.");
    lastYears = undefined;
  }
  if (year && lastYears !== undefined) {
    warnings.push("Both --year and --last-years were provided. --year takes precedence.");
    lastYears = undefined;
  }

  if (sortField === "relevance" && sortOrder) {
    warnings.push("--order is ignored when --sort relevance is used.");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      usage: COLLECT_USAGE
    };
  }

  const query = positionals.join(" ").trim() || undefined;
  const request: CollectCommandRequest = {
    query,
    runQuery,
    limit,
    additional,
    filters: {
      lastYears,
      year,
      dateRange,
      fieldsOfStudy,
      venues,
      publicationTypes,
      minCitationCount,
      openAccessPdf
    },
    sort: {
      field: sortField,
      order: resolveSortOrder(sortField, sortOrder)
    },
    bibtexMode,
    dryRun,
    warnings
  };

  const validationErrors = validateCollectRequest(request);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      errors: validationErrors,
      usage: COLLECT_USAGE
    };
  }

  return {
    ok: true,
    request,
    errors: [],
    usage: COLLECT_USAGE
  };
}

export function validateCollectRequest(req: CollectCommandRequest): string[] {
  const errors: string[] = [];
  if (req.limit !== undefined && req.limit <= 0) {
    errors.push("--limit must be greater than 0.");
  }
  if (req.additional !== undefined && req.additional <= 0) {
    errors.push("--additional must be greater than 0.");
  }
  if (req.filters.lastYears !== undefined && req.filters.lastYears <= 0) {
    errors.push("--last-years must be greater than 0.");
  }
  if (req.filters.year && !YEAR_SPEC_RE.test(req.filters.year)) {
    errors.push("Invalid --year value.");
  }
  if (req.filters.dateRange && !isValidDateRange(req.filters.dateRange)) {
    errors.push("Invalid --date-range value.");
  }
  if (req.filters.minCitationCount !== undefined && req.filters.minCitationCount <= 0) {
    errors.push("--min-citations must be greater than 0.");
  }
  if (req.limit !== undefined && req.additional !== undefined) {
    errors.push("--limit and --additional cannot be used together.");
  }
  return errors;
}

export function tokenizeQuotedArgs(text: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (escape) {
      buf += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      const next = text[i + 1];
      if (
        next &&
        (next === "\\" || next === "'" || next === '"' || /\s/u.test(next))
      ) {
        escape = true;
        continue;
      }
      buf += char;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        buf += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }

    buf += char;
  }

  if (escape) {
    buf += "\\";
  }
  if (buf) {
    tokens.push(buf);
  }
  return tokens;
}

function readPositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return Math.floor(n);
}

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isValidDateRange(value: string): boolean {
  const [start, end] = value.split(":");
  if (end === undefined) {
    return false;
  }
  if (start && !DATE_PART_RE.test(start)) {
    return false;
  }
  if (end && !DATE_PART_RE.test(end)) {
    return false;
  }
  return true;
}

function resolveSortOrder(field: CollectSortField, explicit?: CollectSortOrder): CollectSortOrder {
  if (explicit) {
    return explicit;
  }
  if (field === "paperId") {
    return "asc";
  }
  return "desc";
}
