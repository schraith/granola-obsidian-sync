const DEFAULT_BASE_URL = "https://public-api.granola.ai/v1";
const DEFAULT_REQUEST_INTERVAL_MS = 225;

export interface GranolaApiPerson {
  name?: string;
  email: string;
}

export interface GranolaApiFolder {
  id: string;
  object: "folder";
  name: string;
  parent_folder_id: string | null;
}

export interface GranolaApiTranscriptItem {
  speaker?: {
    source?: string;
    diarization_label?: string;
  };
  text: string;
  start_time?: string;
  end_time?: string;
}

export interface GranolaApiNoteSummary {
  id: string;
  object: "note";
  title: string | null;
  owner: GranolaApiPerson;
  created_at: string;
  updated_at: string;
}

export interface GranolaApiNote extends GranolaApiNoteSummary {
  web_url: string;
  calendar_event: {
    event_title?: string;
    invitees?: Array<{ email: string }>;
    organiser?: string;
    calendar_event_id?: string;
    scheduled_start_time?: string;
    scheduled_end_time?: string;
  } | null;
  attendees: GranolaApiPerson[];
  folder_membership: GranolaApiFolder[];
  summary_text: string;
  summary_markdown: string | null;
  transcript: GranolaApiTranscriptItem[] | null;
}

interface ListNotesResponse {
  notes: GranolaApiNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
}

interface TranscriptPageResponse {
  transcript: GranolaApiTranscriptItem[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaPublicApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GranolaPublicApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GranolaPublicApiError";
  }
}

export class GranolaPublicApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private nextRequestAt = 0;

  constructor(options: GranolaPublicApiClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Granola public API key is required");
    }

    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl || fetch;
    this.requestIntervalMs =
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.sleep =
      options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async listNotes(limit: number): Promise<GranolaApiNoteSummary[]> {
    const requestedLimit = Math.max(1, limit);
    const notes: GranolaApiNoteSummary[] = [];
    let cursor: string | null = null;

    do {
      const url = new URL(`${this.baseUrl}/notes`);
      url.searchParams.set(
        "page_size",
        String(Math.min(30, requestedLimit - notes.length)),
      );
      if (cursor) url.searchParams.set("cursor", cursor);

      const page = await this.requestJson<ListNotesResponse>(url);
      if (!Array.isArray(page.notes)) {
        throw new GranolaPublicApiError(
          "Granola public API returned an invalid notes response",
        );
      }

      notes.push(...page.notes);
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor && notes.length < requestedLimit);

    return notes.slice(0, requestedLimit);
  }

  async getNote(
    noteId: string,
    includeTranscript: boolean = true,
  ): Promise<GranolaApiNote> {
    if (!/^not_[a-zA-Z0-9]{14}$/.test(noteId)) {
      throw new GranolaPublicApiError(`Invalid Granola note ID: ${noteId}`);
    }

    const url = new URL(`${this.baseUrl}/notes/${encodeURIComponent(noteId)}`);
    if (includeTranscript) url.searchParams.set("include", "transcript");

    if (!includeTranscript) {
      return this.requestJson<GranolaApiNote>(url);
    }

    try {
      return await this.requestJson<GranolaApiNote>(url);
    } catch (error) {
      if (error instanceof GranolaPublicApiError && error.status === 413) {
        // Transcript too large to return inline — fetch it page by page.
        const urlNoTranscript = new URL(`${this.baseUrl}/notes/${encodeURIComponent(noteId)}`);
        const note = await this.requestJson<GranolaApiNote>(urlNoTranscript);
        note.transcript = await this.getTranscript(noteId);
        return note;
      }
      throw error;
    }
  }

  /** Fetch all transcript items for a note using the paginated transcript endpoint. */
  async getTranscript(noteId: string): Promise<GranolaApiTranscriptItem[]> {
    const allItems: GranolaApiTranscriptItem[] = [];
    let cursor: string | null = null;

    do {
      const url = new URL(`${this.baseUrl}/notes/${encodeURIComponent(noteId)}/transcript`);
      if (cursor) url.searchParams.set("cursor", cursor);

      const page = await this.requestJson<TranscriptPageResponse>(url);
      if (Array.isArray(page.transcript)) {
        allItems.push(...page.transcript);
      }
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);

    return allItems;
  }

  private async requestJson<T>(url: URL): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.waitForRateLimit();
      const response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });

      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * 2 ** attempt,
        );
        continue;
      }

      if (!response.ok) {
        const body = (await response.text()).trim().slice(0, 300);
        throw new GranolaPublicApiError(
          `Granola public API request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
          response.status,
        );
      }

      return response.json() as Promise<T>;
    }

    throw new GranolaPublicApiError("Granola public API rate limit retries exhausted", 429);
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    if (now < this.nextRequestAt) {
      await this.sleep(this.nextRequestAt - now);
    }
    this.nextRequestAt = Date.now() + this.requestIntervalMs;
  }
}

