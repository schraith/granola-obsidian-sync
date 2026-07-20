import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir } from "fs/promises";
import { join } from "path";
import {
  GranolaPublicApiClient,
  GranolaPublicApiError,
} from "../granola-public-api";

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("GranolaPublicApiClient", () => {
  test("paginates list responses and respects the requested limit", async () => {
    const urls: string[] = [];
    const client = new GranolaPublicApiClient({
      apiKey: "grn_test",
      requestIntervalMs: 0,
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (urls.length === 1) {
          return jsonResponse({
            notes: Array.from({ length: 30 }, (_, index) => ({
              id: `not_${String(index).padStart(14, "0")}`,
              object: "note",
              title: `Note ${index}`,
              owner: { email: "owner@example.com" },
              created_at: "2026-07-20T12:00:00Z",
              updated_at: "2026-07-20T12:30:00Z",
            })),
            hasMore: true,
            cursor: "next-page",
          });
        }
        return jsonResponse({
          notes: Array.from({ length: 10 }, (_, index) => ({
            id: `not_${String(index + 30).padStart(14, "0")}`,
            object: "note",
            title: `Note ${index + 30}`,
            owner: { email: "owner@example.com" },
            created_at: "2026-07-20T12:00:00Z",
            updated_at: "2026-07-20T12:30:00Z",
          })),
          hasMore: false,
          cursor: null,
        });
      },
    });

    const notes = await client.listNotes(35);

    expect(notes).toHaveLength(35);
    expect(urls[0]).toContain("page_size=30");
    expect(urls[1]).toContain("page_size=5");
    expect(urls[1]).toContain("cursor=next-page");
  });

  test("requests transcript details with bearer authentication", async () => {
    let authorization = "";
    let requestedUrl = "";
    const client = new GranolaPublicApiClient({
      apiKey: "grn_secret",
      requestIntervalMs: 0,
      fetchImpl: async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") || "";
        return jsonResponse({ id: "not_1234567890abcd", transcript: [] });
      },
    });

    await client.getNote("not_1234567890abcd");

    expect(requestedUrl).toContain("include=transcript");
    expect(authorization).toBe("Bearer grn_secret");
  });

  test("retries a rate-limited request without exposing the API key", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const client = new GranolaPublicApiClient({
      apiKey: "grn_do_not_log",
      requestIntervalMs: 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) {
          return jsonResponse({ error: "slow down" }, 429, { "retry-after": "2" });
        }
        return jsonResponse({ notes: [], hasMore: false, cursor: null });
      },
    });

    await client.listNotes(1);

    expect(attempts).toBe(2);
    expect(sleeps).toContain(2000);
  });

  test("reports authentication failures with status but not credentials", async () => {
    const client = new GranolaPublicApiClient({
      apiKey: "grn_do_not_log",
      requestIntervalMs: 0,
      fetchImpl: async () => jsonResponse({ error: "unauthorized" }, 401),
    });

    try {
      await client.listNotes(1);
      throw new Error("expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GranolaPublicApiError);
      expect((error as GranolaPublicApiError).status).toBe(401);
      expect((error as Error).message).not.toContain("grn_do_not_log");
    }
  });
});

describe("public API sync integration", () => {
  const noteId = "not_1234567890abcd";
  const stableDocumentId = "11111111-2222-4333-8444-555555555555";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/notes") {
        return jsonResponse({
          notes: [{
            id: noteId,
            object: "note",
            title: "API integration smoke test",
            owner: { name: "Owner", email: "owner@example.com" },
            created_at: "2026-07-19T17:00:00Z",
            updated_at: "2026-07-19T18:00:00Z",
          }],
          hasMore: false,
          cursor: null,
        });
      }
      if (url.pathname === `/v1/notes/${noteId}`) {
        return jsonResponse({
          id: noteId,
          object: "note",
          title: "API integration smoke test",
          owner: { name: "Owner", email: "owner@example.com" },
          created_at: "2026-07-19T17:00:00Z",
          updated_at: "2026-07-19T18:00:00Z",
          web_url: `https://notes.granola.ai/d/${stableDocumentId}`,
          calendar_event: {
            event_title: "API integration smoke test",
            organiser: "owner@example.com",
            scheduled_start_time: "2026-07-19T17:00:00Z",
            scheduled_end_time: "2026-07-19T17:30:00Z",
          },
          attendees: [
            { name: "Owner", email: "owner@example.com" },
            { name: "Guest", email: "guest@example.com" },
          ],
          folder_membership: [],
          summary_text: "Public API summary.",
          summary_markdown: "### Decision\n\nUse the supported API.",
          transcript: [{
            speaker: { source: "microphone" },
            text: "This is a public API transcript.",
            start_time: "2026-07-19T17:00:00Z",
            end_time: "2026-07-19T17:00:05Z",
          }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  afterAll(() => server.stop(true));

  test("writes public API summaries with the historical stable document ID", async () => {
    const vaultRoot = await mkdtemp("/private/tmp/granola-public-sync-");
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "sync.ts"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: process.env.PATH || "",
          GRANOLA_API_KEY: "grn_test",
          GRANOLA_PUBLIC_API_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          GRANOLA_MEETINGS_LIMIT: "1",
          OBSIDIAN_VAULT_ROOT_PATH: vaultRoot,
          OBSIDIAN_VAULT_MEETINGS_PATH: "Meetings",
          OWNER_EMAILS: "owner@example.com",
          SYNC_TRANSCRIPT: "true",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

    const meetingDir = join(vaultRoot, "Meetings", "Ad-hoc");
    const files = await readdir(meetingDir);
    expect(files).toHaveLength(1);
    const markdown = await readFile(join(meetingDir, files[0]), "utf-8");
    expect(markdown).toContain(`calendar_event_id: ${stableDocumentId}`);
    expect(markdown).toContain("Use the supported API.");
    expect(markdown).toContain("This is a public API transcript.");
  });
});
