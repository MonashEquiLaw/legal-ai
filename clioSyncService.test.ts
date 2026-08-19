import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import {
  configureClioSync,
  syncLeadToClio,
  ScoredLead,
  LeadRepository,
  ClioTokenRefresher,
} from "./clioSyncService";

const mock = new MockAdapter(axios);

const sampleLead: ScoredLead = {
  id: "lead_1001",
  clientFirstName: "Maria",
  clientLastName: "Delgado",
  clientPhone: "3055551234",
  clientEmail: "maria.delgado@example.com",
  jurisdictionState: "FL",
  incidentDate: "2026-07-02",
  executiveBrief: "Rear-ended at a red light; hospitalized overnight.",
  injurySeverity: "HOSPITALIZED",
  scoreStatus: "HOT",
  confidenceScore: 0.93,
  transcript: [
    { speaker: "ai", content: "Can you tell me what happened?", timestamp: "2026-08-18T14:10:00Z" },
    { speaker: "client", content: "I was rear-ended on I-95.", timestamp: "2026-08-18T14:11:00Z" },
  ],
  customFieldValues: [{ customFieldId: "999", value: "Referral: Web Form" }],
};

const leadRepository: LeadRepository = {
  async getScoredLead(leadId: string) {
    if (leadId === "missing") return null;
    return sampleLead;
  },
};

let refreshCallCount = 0;
const tokenRefresher: ClioTokenRefresher = {
  async refreshAccessToken(expiredToken: string) {
    refreshCallCount++;
    return "fresh-token-" + refreshCallCount;
  },
};

const logs: string[] = [];
configureClioSync({
  leadRepository,
  tokenRefresher,
  logger: {
    info: (m) => logs.push(`INFO: ${m}`),
    warn: (m) => logs.push(`WARN: ${m}`),
    error: (m) => logs.push(`ERROR: ${m}`),
  },
});

async function resetAndSetupHappyPath() {
  mock.reset();
  mock.onGet(/contacts\.json/).reply(200, { data: [] }); // no existing contact
  mock.onPost(/contacts\.json/).reply(201, { data: { id: "contact_1" } });
  mock.onPost(/matters\.json/).reply(201, { data: { id: "matter_1" } });
  mock.onPost(/notes\.json/).reply(201, { data: { id: "note_1" } });
}

async function test1_happyPath() {
  await resetAndSetupHappyPath();
  const result = await syncLeadToClio("lead_1001", "good-token");
  console.assert(result.success === true, "Test 1 FAILED: expected success");
  console.assert(result.clioMatterId === "matter_1", "Test 1 FAILED: wrong matter id");
  console.log("Test 1 (happy path, no existing contact) PASS:", JSON.stringify(result));
}

async function test2_existingContactFoundByEmail() {
  mock.reset();
  mock.onGet(/contacts\.json/).reply(200, {
    data: [{ id: "contact_existing", email_addresses: [{ address: "maria.delgado@example.com" }], phone_numbers: [] }],
  });
  mock.onPost(/matters\.json/).reply(201, { data: { id: "matter_2" } });
  mock.onPost(/notes\.json/).reply(201, { data: { id: "note_2" } });

  const result = await syncLeadToClio("lead_1001", "good-token");
  console.assert(result.success === true, "Test 2 FAILED: expected success");
  console.assert(result.clioMatterId === "matter_2", "Test 2 FAILED: wrong matter id");
  // Ensure contact POST was never called since we matched an existing one.
  const postToContacts = mock.history.post.filter((r) => r.url?.includes("contacts.json"));
  console.assert(postToContacts.length === 0, "Test 2 FAILED: should not have created a new contact");
  console.log("Test 2 (existing contact matched by email) PASS:", JSON.stringify(result));
}

async function test3_401TriggersRefreshThenSucceeds() {
  refreshCallCount = 0;
  mock.reset();
  let contactGetCallCount = 0;
  mock.onGet(/contacts\.json/).reply(() => {
    contactGetCallCount++;
    if (contactGetCallCount === 1) {
      return [401, { error: "invalid_token" }];
    }
    return [200, { data: [] }];
  });
  mock.onPost(/contacts\.json/).reply(201, { data: { id: "contact_3" } });
  mock.onPost(/matters\.json/).reply(201, { data: { id: "matter_3" } });
  mock.onPost(/notes\.json/).reply(201, { data: { id: "note_3" } });

  const result = await syncLeadToClio("lead_1001", "stale-token");
  console.assert(result.success === true, "Test 3 FAILED: expected success after refresh");
  console.assert(refreshCallCount === 1, `Test 3 FAILED: expected exactly 1 refresh, got ${refreshCallCount}`);
  console.log("Test 3 (401 -> refresh -> retry -> success) PASS:", JSON.stringify(result), "refreshCalls:", refreshCallCount);
}

async function test4_429TriggersBackoffThenSucceeds() {
  mock.reset();
  let getAttempts = 0;
  mock.onGet(/contacts\.json/).reply(() => {
    getAttempts++;
    if (getAttempts <= 2) {
      return [429, { error: "rate_limited" }, { "retry-after": "0" }]; // 0s so test runs fast
    }
    return [200, { data: [] }];
  });
  mock.onPost(/contacts\.json/).reply(201, { data: { id: "contact_4" } });
  mock.onPost(/matters\.json/).reply(201, { data: { id: "matter_4" } });
  mock.onPost(/notes\.json/).reply(201, { data: { id: "note_4" } });

  const start = Date.now();
  const result = await syncLeadToClio("lead_1001", "good-token");
  const elapsed = Date.now() - start;
  console.assert(result.success === true, "Test 4 FAILED: expected success after backoff retries");
  console.assert(getAttempts === 3, `Test 4 FAILED: expected 3 GET attempts, got ${getAttempts}`);
  console.log(`Test 4 (429 -> backoff x2 -> success) PASS: ${JSON.stringify(result)} (attempts=${getAttempts}, elapsed=${elapsed}ms)`);
}

async function test5_leadNotFound() {
  await resetAndSetupHappyPath();
  const result = await syncLeadToClio("missing", "good-token");
  console.assert(result.success === false, "Test 5 FAILED: expected failure for missing lead");
  console.assert(!!result.error, "Test 5 FAILED: expected error message");
  console.log("Test 5 (lead not found) PASS:", JSON.stringify(result));
}

async function test6_persistentFailureReturnsErrorNotThrow() {
  mock.reset();
  mock.onGet(/contacts\.json/).reply(200, { data: [] });
  mock.onPost(/contacts\.json/).reply(500, { error: "internal_error" });

  const result = await syncLeadToClio("lead_1001", "good-token");
  console.assert(result.success === false, "Test 6 FAILED: expected failure");
  console.assert(!!result.error, "Test 6 FAILED: expected error string");
  console.log("Test 6 (persistent 500 -> clean failure, no throw) PASS:", JSON.stringify(result));
}

async function main() {
  await test1_happyPath();
  await test2_existingContactFoundByEmail();
  await test3_401TriggersRefreshThenSucceeds();
  await test4_429TriggersBackoffThenSucceeds();
  await test5_leadNotFound();
  await test6_persistentFailureReturnsErrorNotThrow();
  console.log("\nALL RUNTIME TESTS PASSED");
}

main().catch((err) => {
  console.error("TEST SUITE THREW UNEXPECTEDLY:", err);
  process.exit(1);
});
