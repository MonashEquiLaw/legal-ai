/**
 * clioSyncService.ts
 * ------------------
 * Syncs an AI-scored intake lead (LegalGate) into Clio Manage (API v4):
 *   1. Find-or-create the client as a Person contact.
 *   2. Create a Matter linked to that contact, carrying the AI executive brief.
 *   3. Attach the full intake transcript to the Matter as a Note.
 *
 * Design notes
 * ------------
 * - Dependencies (how to load the scored lead, how to refresh an expired
 *   OAuth token, and how to log) are injected via `configureClioSync(...)`
 *   rather than hardcoded, so this module stays testable and portable across
 *   services. Call `configureClioSync` once at app startup.
 * - Field names for `contacts.json` / `matters.json` reflect Clio's public
 *   v4 API reference as of this writing. `notes.json` field names
 *   (`subject` / `detail`) follow Clio's documented Notes resource shape —
 *   verify against your current API reference / sandbox before going live,
 *   since third-party API surfaces do evolve.
 */

import axios, { AxiosError, AxiosRequestConfig } from "axios";

// --------------------------------------------------------------------------- //
// Configuration
// --------------------------------------------------------------------------- //

const CLIO_BASE_URL = process.env.CLIO_API_BASE_URL ?? "https://app.clio.com/api/v4";

const MAX_RATE_LIMIT_RETRIES = 5;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

// --------------------------------------------------------------------------- //
// Public types
// --------------------------------------------------------------------------- //

export type InjurySeverity = "NONE" | "MINOR" | "SEVERE" | "HOSPITALIZED";
export type ScoreStatus = "HOT" | "WARM" | "COLD";

export interface TranscriptMessage {
  speaker: "ai" | "client";
  content: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

export interface CustomFieldValue {
  /** Clio custom field ID configured on the firm's Matter custom field set. */
  customFieldId: string;
  value: string;
}

/**
 * The scored, AI-screened lead as produced by the LegalGate intake +
 * lead-scoring pipeline. Adjust field names here if your internal schema
 * differs — this is the seam between "your data" and "Clio's API shape".
 */
export interface ScoredLead {
  id: string;
  clientFirstName: string;
  clientLastName: string;
  clientPhone: string;
  clientEmail: string;
  jurisdictionState: string;
  incidentDate: string;
  /** AI-generated executive case brief, used as the Matter description. */
  executiveBrief: string;
  injurySeverity: InjurySeverity;
  scoreStatus: ScoreStatus;
  confidenceScore: number;
  transcript: TranscriptMessage[];
  customFieldValues?: CustomFieldValue[];
}

export interface SyncLeadResult {
  success: boolean;
  clioMatterId?: string;
  error?: string;
}

// --------------------------------------------------------------------------- //
// Injected dependencies
// --------------------------------------------------------------------------- //

export interface LeadRepository {
  /** Load the scored lead this sync operation is for. Return null if not found. */
  getScoredLead(leadId: string): Promise<ScoredLead | null>;
}

export interface ClioTokenRefresher {
  /**
   * Called when Clio responds 401 for the given (now-invalid) access token.
   * Should look up the firm's stored refresh token, exchange it with Clio's
   * OAuth token endpoint, persist the new tokens, and return the new access
   * token. Throw if the firm cannot be re-authenticated (e.g. refresh token
   * itself is revoked) — syncLeadToClio will surface that as a failure.
   */
  refreshAccessToken(expiredAccessToken: string): Promise<string>;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: Logger = {
  info: (message, meta) => console.log(JSON.stringify({ level: "info", message, ...meta })),
  warn: (message, meta) => console.warn(JSON.stringify({ level: "warn", message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: "error", message, ...meta })),
};

const notConfigured = (name: string) => (): never => {
  throw new Error(
    `clioSyncService: no ${name} configured. Call configureClioSync({ ${name}: ... }) at app startup.`
  );
};

interface ClioSyncDependencies {
  leadRepository: LeadRepository;
  tokenRefresher: ClioTokenRefresher;
  logger: Logger;
}

const dependencies: ClioSyncDependencies = {
  leadRepository: { getScoredLead: notConfigured("leadRepository") },
  tokenRefresher: { refreshAccessToken: notConfigured("tokenRefresher") },
  logger: consoleLogger,
};

/**
 * Configure this module's dependencies. Call once at application startup
 * (or per-test, to inject mocks). Partial config merges over the current
 * dependencies rather than replacing them wholesale.
 */
export function configureClioSync(config: Partial<ClioSyncDependencies>): void {
  Object.assign(dependencies, config);
}

// --------------------------------------------------------------------------- //
// Errors
// --------------------------------------------------------------------------- //

export class ClioApiError extends Error {
  readonly status?: number;
  readonly clioErrors?: unknown;

  constructor(message: string, status?: number, clioErrors?: unknown) {
    super(message);
    this.name = "ClioApiError";
    this.status = status;
    this.clioErrors = clioErrors;
  }
}

// --------------------------------------------------------------------------- //
// Low-level HTTP: retry (429) + token refresh (401) wrapper
// --------------------------------------------------------------------------- //

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, honoring a Retry-After header when Clio sends one. */
function computeBackoffDelayMs(attempt: number, retryAfterHeader?: string): number {
  if (retryAfterHeader) {
    const secondsFromHeader = Number(retryAfterHeader);
    if (!Number.isNaN(secondsFromHeader)) {
      return Math.min(secondsFromHeader * 1000, MAX_BACKOFF_MS);
    }
  }
  const exponential = INITIAL_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * INITIAL_BACKOFF_MS;
  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

interface ClioResponseEnvelope<T> {
  data: T;
}

/**
 * Executes a single logical Clio API call, transparently:
 *   - retrying with exponential backoff on 429 (up to MAX_RATE_LIMIT_RETRIES)
 *   - refreshing the access token exactly once on 401 and retrying
 *
 * Returns both the parsed response body and whichever access token ended up
 * being used, so the caller can carry a refreshed token forward into
 * subsequent steps instead of hitting a stale one again.
 */
async function executeClioRequest<T>(
  buildConfig: (accessToken: string) => AxiosRequestConfig,
  accessToken: string,
  context: Record<string, unknown>
): Promise<{ data: T; accessToken: string }> {
  let token = accessToken;
  let hasRefreshed = false;
  let attempt = 0;

  // Bounded loop: at most one token refresh + MAX_RATE_LIMIT_RETRIES backoff
  // retries, so this can never spin forever.
  for (;;) {
    try {
      const config = buildConfig(token);
      const response = await axios.request<ClioResponseEnvelope<T>>({
        timeout: REQUEST_TIMEOUT_MS,
        ...config,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...config.headers,
        },
      });
      return { data: response.data.data, accessToken: token };
    } catch (err) {
      const axiosErr = err as AxiosError<{ error?: unknown; errors?: unknown }>;

      if (!axios.isAxiosError(axiosErr) || !axiosErr.response) {
        // Network-level failure (DNS, timeout, connection reset) — not
        // retried here; caller's outer error handling decides what to do.
        throw new ClioApiError(
          `Clio request failed with no response: ${(err as Error).message}`,
          undefined
        );
      }

      const { status, headers, data } = axiosErr.response;

      if (status === 401 && !hasRefreshed) {
        dependencies.logger.warn("Clio access token expired; refreshing", context);
        token = await dependencies.tokenRefresher.refreshAccessToken(token);
        hasRefreshed = true;
        continue;
      }

      if (status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = headers["retry-after"] as string | undefined;
        const delayMs = computeBackoffDelayMs(attempt, retryAfter);
        dependencies.logger.warn("Clio rate limit hit; backing off", {
          ...context,
          attempt: attempt + 1,
          delayMs,
        });
        await sleep(delayMs);
        attempt++;
        continue;
      }

      // Treat transient 5xx as retryable with the same backoff policy.
      if (status >= 500 && status < 600 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const delayMs = computeBackoffDelayMs(attempt);
        dependencies.logger.warn("Clio server error; retrying", {
          ...context,
          status,
          attempt: attempt + 1,
          delayMs,
        });
        await sleep(delayMs);
        attempt++;
        continue;
      }

      throw new ClioApiError(
        `Clio API returned ${status} for ${context.step ?? "request"}`,
        status,
        data?.errors ?? data?.error
      );
    }
  }
}

// --------------------------------------------------------------------------- //
// Step 1 — Find or create the Person contact
// --------------------------------------------------------------------------- //

interface ClioContact {
  id: string | number;
  email_addresses?: { address: string }[];
  phone_numbers?: { number: string }[];
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function findExistingContact(
  lead: ScoredLead,
  accessToken: string
): Promise<{ contactId: string; accessToken: string } | null> {
  const { data, accessToken: nextToken } = await executeClioRequest<ClioContact[]>(
    (_token) => ({
      method: "GET",
      url: `${CLIO_BASE_URL}/contacts.json`,
      params: {
        query: lead.clientEmail,
        fields: "id,email_addresses,phone_numbers",
      },
    }),
    accessToken,
    { step: "find_contact", leadId: lead.id }
  );

  const normalizedTargetPhone = normalizePhone(lead.clientPhone);

  const match = data.find((contact) => {
    const emailMatch = contact.email_addresses?.some(
      (e) => e.address.toLowerCase() === lead.clientEmail.toLowerCase()
    );
    const phoneMatch = contact.phone_numbers?.some(
      (p) => normalizePhone(p.number) === normalizedTargetPhone
    );
    return emailMatch || phoneMatch;
  });

  if (!match) return null;
  return { contactId: String(match.id), accessToken: nextToken };
}

async function createContact(
  lead: ScoredLead,
  accessToken: string
): Promise<{ contactId: string; accessToken: string }> {
  const { data, accessToken: nextToken } = await executeClioRequest<{ id: string | number }>(
    (_token) => ({
      method: "POST",
      url: `${CLIO_BASE_URL}/contacts.json`,
      data: {
        data: {
          type: "Person",
          first_name: lead.clientFirstName,
          last_name: lead.clientLastName,
          email_addresses: [
            { name: "Work", address: lead.clientEmail, primary: true },
          ],
          phone_numbers: [
            { name: "Mobile", number: lead.clientPhone, primary: true },
          ],
        },
      },
    }),
    accessToken,
    { step: "create_contact", leadId: lead.id }
  );

  return { contactId: String(data.id), accessToken: nextToken };
}

async function findOrCreateContact(
  lead: ScoredLead,
  accessToken: string
): Promise<{ contactId: string; accessToken: string }> {
  const existing = await findExistingContact(lead, accessToken);
  if (existing) {
    dependencies.logger.info("Matched existing Clio contact", {
      leadId: lead.id,
      contactId: existing.contactId,
    });
    return existing;
  }

  const created = await createContact(lead, accessToken);
  dependencies.logger.info("Created new Clio contact", {
    leadId: lead.id,
    contactId: created.contactId,
  });
  return created;
}

// --------------------------------------------------------------------------- //
// Step 2 — Create the Matter
// --------------------------------------------------------------------------- //

async function createMatter(
  lead: ScoredLead,
  contactId: string,
  accessToken: string
): Promise<{ matterId: string; accessToken: string }> {
  const customFieldValues = lead.customFieldValues?.map((field) => ({
    custom_field: { id: field.customFieldId },
    value: field.value,
  }));

  const { data, accessToken: nextToken } = await executeClioRequest<{ id: string | number }>(
    (_token) => ({
      method: "POST",
      url: `${CLIO_BASE_URL}/matters.json`,
      data: {
        data: {
          client: { id: contactId },
          description: lead.executiveBrief,
          status: "Open",
          ...(customFieldValues && customFieldValues.length > 0
            ? { custom_field_values: customFieldValues }
            : {}),
        },
      },
    }),
    accessToken,
    { step: "create_matter", leadId: lead.id, contactId }
  );

  return { matterId: String(data.id), accessToken: nextToken };
}

// --------------------------------------------------------------------------- //
// Step 3 — Attach transcript as a Note
// --------------------------------------------------------------------------- //

function renderTranscript(transcript: TranscriptMessage[]): string {
  return transcript
    .map((message) => {
      const speakerLabel = message.speaker === "ai" ? "AI Intake Coordinator" : "Client";
      const timestamp = new Date(message.timestamp).toLocaleString("en-US");
      return `[${timestamp}] ${speakerLabel}: ${message.content}`;
    })
    .join("\n\n");
}

async function attachTranscriptNote(
  lead: ScoredLead,
  matterId: string,
  accessToken: string
): Promise<{ accessToken: string }> {
  const { accessToken: nextToken } = await executeClioRequest<{ id: string | number }>(
    (_token) => ({
      method: "POST",
      url: `${CLIO_BASE_URL}/notes.json`,
      data: {
        data: {
          matter: { id: matterId },
          subject: "AI Intake Transcript",
          detail: renderTranscript(lead.transcript),
        },
      },
    }),
    accessToken,
    { step: "attach_transcript_note", leadId: lead.id, matterId }
  );

  return { accessToken: nextToken };
}

// --------------------------------------------------------------------------- //
// Public entry point
// --------------------------------------------------------------------------- //

/**
 * Syncs a scored intake lead into Clio: finds or creates the client contact,
 * opens a matter with the AI executive brief, and attaches the full intake
 * transcript as a note on that matter.
 *
 * Never throws — all failure modes (missing lead, Clio API errors, auth
 * failures) resolve to `{ success: false, error }` so callers (e.g. an API
 * route handler) don't need their own try/catch around this call.
 */
export async function syncLeadToClio(
  leadId: string,
  firmAccessToken: string
): Promise<SyncLeadResult> {
  const logContext = { leadId };

  try {
    const lead = await dependencies.leadRepository.getScoredLead(leadId);
    if (!lead) {
      dependencies.logger.error("Lead not found for Clio sync", logContext);
      return { success: false, error: `Lead ${leadId} was not found.` };
    }

    dependencies.logger.info("Starting Clio sync", logContext);

    const { contactId, accessToken: tokenAfterContact } = await findOrCreateContact(
      lead,
      firmAccessToken
    );

    const { matterId, accessToken: tokenAfterMatter } = await createMatter(
      lead,
      contactId,
      tokenAfterContact
    );

    await attachTranscriptNote(lead, matterId, tokenAfterMatter);

    dependencies.logger.info("Clio sync completed", {
      ...logContext,
      contactId,
      matterId,
    });

    return { success: true, clioMatterId: matterId };
  } catch (err) {
    const message =
      err instanceof ClioApiError
        ? `${err.message}${err.clioErrors ? ` — ${JSON.stringify(err.clioErrors)}` : ""}`
        : err instanceof Error
          ? err.message
          : "Unknown error during Clio sync.";

    dependencies.logger.error("Clio sync failed", { ...logContext, error: message });
    return { success: false, error: message };
  }
}
