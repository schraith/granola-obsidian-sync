#!/usr/bin/env bun

import "dotenv/config";
import {
  readFile,
  writeFile,
  mkdir,
  access,
  readdir,
  stat,
  appendFile,
} from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import matter from "gray-matter";
import {
  processTranscript,
  shouldSkipPastMeeting,
} from "./transcript-processor";
import { processPanels } from "./panel-processor";
import { networkInterfaces } from "os";

const execFileAsync = promisify(execFile);

// --- CONFIGURATION ---
// All user-configurable values are sourced from environment variables.
// See .env.example for details.

const requiredEnvVars = ["GRANOLA_AUTH_PATH", "OBSIDIAN_VAULT_ROOT_PATH", "OBSIDIAN_VAULT_MEETINGS_PATH"];

// Helper to resolve tilde (~) in paths
const resolvePath = (p: string) =>
  p.startsWith("~") ? join(homedir(), p.slice(1)) : p;

// Validate required environment variables
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(
      `Missing required environment variable: ${varName}. Please copy .env.example to .env and set this value.`,
    );
  }
}

const config = {
  granolaAuthPath: resolvePath(process.env.GRANOLA_AUTH_PATH!),
  obsidianVaultRoot: resolvePath(process.env.OBSIDIAN_VAULT_ROOT_PATH!),
  obsidianVaultMeetingsPath: process.env.OBSIDIAN_VAULT_MEETINGS_PATH!,
  meetingsLimit: parseInt(process.env.GRANOLA_MEETINGS_LIMIT || "50"),
  syncTranscript: process.env.SYNC_TRANSCRIPT === "true",
  transcriptTitleFilter:
    process.env.TRANSCRIPT_TITLE_FILTER?.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean) || [],
  // Meeting processing config
  enableMeetingProcessing: process.env.ENABLE_MEETING_PROCESSING === "true",
  vaultOpsScriptPath: process.env.VAULT_OPS_SCRIPT_PATH,
  // Debug logging
  debug: process.env.DEBUG === "true",
  // Pushover config for future use
  pushover: {
    userKey: process.env.PUSHOVER_USER_KEY,
    apiToken: process.env.PUSHOVER_API_TOKEN,
  },
};

// Check external script exists if processing is enabled (log but don't fail)
if (config.enableMeetingProcessing) {
  if (!config.vaultOpsScriptPath || !existsSync(config.vaultOpsScriptPath)) {
    console.log(
      `⚠️  External script not found: ${config.vaultOpsScriptPath}. Meeting processing will be skipped.`,
    );
  }
}

// --- END CONFIGURATION ---

// LOGGING SETUP
const getPSTDateString = (): string => {
  const now = new Date();
  return now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
};

const logDir = join(homedir(), ".granola-sync-logs");
const logFile = join(logDir, `sync-${getPSTDateString()}.log`);

// Ensure log directory exists
await mkdir(logDir, { recursive: true }).catch(() => {});

async function log(message: string): Promise<void> {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const logMessage = `[${timestamp}] ${message}`;
  console.log(message);
  await appendFile(logFile, logMessage + "\n").catch(() => {});
}

async function logError(message: string): Promise<void> {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const logMessage = `[${timestamp}] ERROR: ${message}`;
  console.error(message);
  await appendFile(logFile, logMessage + "\n").catch(() => {});
}

// NETWORK CONNECTIVITY CHECK
function hasNetworkConnection(): boolean {
  const interfaces = networkInterfaces();
  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (
        addr.family === "IPv4" &&
        !addr.internal &&
        addr.address !== "0.0.0.0"
      ) {
        return true;
      }
    }
  }
  return false;
}

// FAILURE TRACKING
const failureCountFile = join(logDir, ".granola-sync-failures");

async function incrementFailureCount(): Promise<number> {
  try {
    const content = await readFile(failureCountFile, "utf-8");
    const count = parseInt(content) || 0;
    await writeFile(failureCountFile, String(count + 1), "utf-8");
    return count + 1;
  } catch {
    await writeFile(failureCountFile, "1", "utf-8");
    return 1;
  }
}

async function resetFailureCount(): Promise<void> {
  await writeFile(failureCountFile, "0", "utf-8").catch(() => {});
}

async function getFailureCount(): Promise<number> {
  try {
    const content = await readFile(failureCountFile, "utf-8");
    return parseInt(content) || 0;
  } catch {
    return 0;
  }
}

// Load meeting mappings
let meetingMappings: {
  oneOnOne: Record<string, string>;
  recurring: Record<string, string>;
} = { oneOnOne: {}, recurring: {} };
try {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const mappingsContent = await readFile(
    join(currentDir, "meeting-mappings.json"),
    "utf-8",
  );
  meetingMappings = JSON.parse(mappingsContent);
} catch (error) {
  console.warn(
    "⚠️  Could not load meeting-mappings.json, proceeding without meeting categorization",
  );
}

const API_BASE = "https://api.granola.ai/v1";
const VAULT_ROOT = config.obsidianVaultRoot;
const VAULT_PATH = join(config.obsidianVaultRoot, config.obsidianVaultMeetingsPath);
const TOKEN_PATH = config.granolaAuthPath;

// Owner emails - used to identify "me" when inferring 1:1 partner from attendees
const OWNER_EMAILS = new Set(
  (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

// CLI / ENV OVERRIDES
// Allow forcing a re-sync of a single Granola document by ID
const argv = process.argv.slice(2);
let forceDocumentId: string | undefined = process.env.FORCE_GRANOLA_ID;

const forceFlagIndex = argv.indexOf("--force");
if (!forceDocumentId && forceFlagIndex !== -1 && argv[forceFlagIndex + 1]) {
  forceDocumentId = argv[forceFlagIndex + 1];
}

const isForceMode = !!forceDocumentId;

// Template identification for panel processing
const TEMPLATE_SLUG = "b491d27c-1106-4ebf-97c5-d5129742945c";

// TYPES
interface GranolaDoc {
  id: string;
  title: string;
  created_at: string;
  workspace?: { name: string };
}

interface DocMetadata {
  attendees?: Array<{ name: string; email: string }>;
  creator?: { name: string; email: string };
  sharing_link_visibility?: string;
}

interface Panel {
  id: string;
  title: string;
  template_slug: string;
  original_content: string;
  created_at: string;
  updated_at: string;
}

// UNIFIED MEETING DATA
interface MeetingData {
  id: string;
  title: string;
  startTime: Date;
  endTime?: Date;
  attendees: string[];
  organizer: string;
  location: string;
  status: "filed" | "scheduled";
  transcript?: string;
  meetingUrl?: string;
  durationMin?: number;
  panelContent?: string;
}

// VAULT INDEX
interface ExistingMeeting {
  filePath: string;
  title: string;
  startTime: Date;
  status: "filed" | "scheduled";
  id: string; // calendar_event_id from frontmatter
  isDeleted?: boolean; // true if found in trash
}

// TITLE NORMALIZATION FOR MATCHING
function normalizeTitle(title: string): string {
  return title
    .replace(/^Re:\s*/i, "") // Remove "Re:" prefix
    .toLowerCase()
    .trim();
}

// ENSURE TITLE IS NOT EMPTY
function ensureTitle(title: string | undefined): string {
  return (title?.trim() || "").length > 0 ? title!.trim() : "No Title Found";
}

// ESCAPE SPECIAL REGEX CHARACTERS IN REPLACEMENT STRINGS
function escapeReplacement(str: string): string {
  return str.replace(/\$/g, "$$$$");
}

// CHECK IF TRANSCRIPT SHOULD BE SYNCED FOR THIS MEETING
function shouldSyncTranscript(title: string): boolean {
  // If no filters are configured, use global setting
  if (config.transcriptTitleFilter.length === 0) {
    return config.syncTranscript;
  }

  // Check if any filter matches the title (case-insensitive)
  const titleLower = title.toLowerCase();
  return config.transcriptTitleFilter.some((filter) =>
    titleLower.includes(filter),
  );
}

// TIME WINDOW MATCHING (12 hours)
function isWithinTimeWindow(time1: Date, time2: Date): boolean {
  const diffMs = Math.abs(time1.getTime() - time2.getTime());
  const diffHours = diffMs / (1000 * 60 * 60);
  return diffHours <= 12;
}

// MEETING CATEGORIZATION
interface MeetingCategory {
  type: "oneOnOne" | "recurring" | "adHoc";
  targetName?: string; // For 1:1 and recurring, the file to append to
}

function isOneOnOneTitle(title: string): boolean {
  // Match various 1:1 formats including full-width colon (：)
  return /\b(1\s*<>\s*1|1[:：]1|1-1|meeting\s+with)\b/i.test(title);
}

// Some 1:1s are also organized into a dedicated Granola folder/workspace
// named "1 <> 1". Treat that as an additional 1:1 signal.
function isOneOnOneByFolder(meeting: GranolaDoc): boolean {
  const workspaceName = meeting.workspace?.name || "";
  return /1\s*<>\s*1/i.test(workspaceName);
}

function categorizeMeeting(title: string): MeetingCategory {
  const titleLower = title.toLowerCase();

  // Check for explicit 1:1 indicators
  const hasOneOnOneIndicator = isOneOnOneTitle(title);

  // Check for 1:1 matches (only if explicit indicator present)
  if (hasOneOnOneIndicator) {
    for (const [keyword, name] of Object.entries(meetingMappings.oneOnOne)) {
      if (titleLower.includes(keyword.toLowerCase())) {
        return { type: "oneOnOne", targetName: name };
      }
    }
  }

  // Check for recurring matches
  for (const [keyword, name] of Object.entries(meetingMappings.recurring)) {
    if (titleLower.includes(keyword.toLowerCase())) {
      return { type: "recurring", targetName: name };
    }
  }

  // Default to ad hoc
  return { type: "adHoc" };
}

// Attempt to infer 1:1 partner from meeting metadata when title-based
// matching is ambiguous or has no unique mapping.
function categorizeOneOnOneFromMetadata(metadata: DocMetadata): MeetingCategory | null {
  const attendees = metadata.attendees || [];
  if (attendees.length === 0) return null;

  // Start with all attendees
  let candidates = attendees.slice();

  // Filter out known owner emails if configured
  if (OWNER_EMAILS.size > 0) {
    candidates = candidates.filter(
      (a) => !a.email || !OWNER_EMAILS.has(a.email.toLowerCase()),
    );
  }

  // Also filter out the meeting creator if present in attendees
  if (metadata.creator && metadata.creator.email) {
    const creatorEmail = metadata.creator.email.toLowerCase();
    candidates = candidates.filter(
      (a) => !a.email || a.email.toLowerCase() !== creatorEmail,
    );
  }

  // For a true 1:1 we expect exactly one non-owner attendee
  if (candidates.length !== 1) return null;

  const candidate = candidates[0];
  const displayName = (candidate.name && candidate.name.trim()) ||
    (candidate.email ? candidate.email.split("@")[0] : "");

  if (!displayName) return null;

  return { type: "oneOnOne", targetName: displayName.trim() };
}

// VAULT INDEXING - SCAN EXISTING MEETING FILES (INCLUDING TRASHED)
async function indexVaultMeetings(
  vaultPath: string,
  includeTrash: boolean = true,
  debug: boolean = false,
): Promise<ExistingMeeting[]> {
  const meetings: ExistingMeeting[] = [];
  const deletedIds = new Set<string>();

  // First, check .trash folder for deleted meetings if it exists
  if (includeTrash) {
    const trashPath = join(VAULT_PATH, ".trash");

    try {
      await access(trashPath);
      // Recursively scan trash for markdown files with Granola IDs
      const scanTrash = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanTrash(fullPath);
          } else if (entry.name.endsWith(".md")) {
            try {
              const content = await readFile(fullPath, "utf-8");
              const parsed = matter(content);
              if (
                parsed.data.source === "granola" &&
                parsed.data.calendar_event_id
              ) {
                deletedIds.add(parsed.data.calendar_event_id);
                const meetingTitle = ensureTitle(
                  parsed.data.title || entry.name,
                );
                if (debug) console.log(`   Found in trash: ${meetingTitle}`);
                // Add to meetings array with isDeleted flag
                meetings.push({
                  filePath: fullPath,
                  title: meetingTitle,
                  startTime: new Date(parsed.data.start_time || ""),
                  status: parsed.data.status || "filed",
                  id: parsed.data.calendar_event_id,
                  isDeleted: true,
                });
              }
            } catch {
              // Skip files that can't be read
            }
          }
        }
      };
      await scanTrash(trashPath);
    } catch (error) {
      // .trash doesn't exist or isn't accessible, that's fine
    }
  }

  try {
    // Check if vault path exists first
    try {
      await access(vaultPath);
    } catch {
      // Vault path doesn't exist - return empty meetings list
      console.log(`⚠️  Vault path does not exist: ${vaultPath}`);
      return meetings;
    }

    // Recursively scan vault directory for markdown files
    const scanDirectory = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Recursively scan subdirectories
          await scanDirectory(fullPath);
        } else if (entry.name.endsWith(".md")) {
          try {
            const content = await readFile(fullPath, "utf-8");
            const parsed = matter(content);
            const frontmatter = parsed.data;

            if (
              frontmatter.source === "granola" &&
              frontmatter.calendar_event_id
            ) {
              meetings.push({
                filePath: fullPath,
                title: ensureTitle(frontmatter.title),
                startTime: new Date(frontmatter.start_time || ""),
                status: frontmatter.status || "scheduled",
                id: frontmatter.calendar_event_id,
                isDeleted: deletedIds.has(frontmatter.calendar_event_id),
              } as any);
            }
          } catch (error) {
            // Skip files that can't be parsed
            continue;
          }
        }
      }
    };

    await scanDirectory(vaultPath);
  } catch (error) {
    console.error("Error indexing vault:", error);
  }

  return meetings;
}

// FIND MATCHING SCHEDULED MEETING
function findMatchingScheduledMeeting(
  filedMeeting: { title: string; startTime: Date },
  existingMeetings: ExistingMeeting[],
): ExistingMeeting | null {
  const normalizedTitle = normalizeTitle(filedMeeting.title);

  for (const existing of existingMeetings) {
    if (existing.status !== "scheduled") continue;

    const existingNormalizedTitle = normalizeTitle(existing.title);

    if (
      existingNormalizedTitle === normalizedTitle &&
      isWithinTimeWindow(filedMeeting.startTime, existing.startTime)
    ) {
      return existing;
    }
  }

  return null;
}

// PUSHOVER NOTIFICATION - FIRE AND FORGET
function sendPushover(title: string, message: string): void {
  if (!config.pushover.userKey || !config.pushover.apiToken) return;

  fetchWithTimeout("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: config.pushover.apiToken,
      user: config.pushover.userKey,
      title,
      message,
      priority: "1",
    }),
    timeout: 10000,
  }).catch((err) => {
    console.error(`Pushover failed: ${err.message}`);
  });
}

// MEETING PROCESSING FUNCTION
async function processSingleMeeting(): Promise<void> {
  if (!config.enableMeetingProcessing) return;

  if (!config.vaultOpsScriptPath || !existsSync(config.vaultOpsScriptPath)) {
    console.log(`⚠️  External script not found, skipping meeting processing`);
    return;
  }

  console.log(`🤖 Calling external processing script...`);

  try {
    // Fire and forget - don't wait for completion
    const { spawn } = await import("child_process");
    spawn("/opt/homebrew/bin/bash", [config.vaultOpsScriptPath], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log(`✅ External script launched (fire and forget)`);
  } catch (error: any) {
    console.error(`❌ Failed to launch external script: ${error.message}`);
    // Don't throw - this shouldn't fail the sync
  }
}

// CONTENT VALIDATION FUNCTION
function hasContent(transcriptData: any, panels?: Panel[]): boolean {
  // Check transcript segments
  const segments = Array.isArray(transcriptData)
    ? transcriptData
    : transcriptData?.segments || transcriptData?.transcript?.segments || [];

  const hasTranscriptContent = segments.length > 0;

  // Check panels
  const hasPanelContent =
    panels &&
    panels.length > 0 &&
    panels.some(
      (p) => p.original_content && p.original_content.trim().length > 0,
    );

  return hasTranscriptContent || hasPanelContent || false;
}

// CHECK IF MEETING IS IN THE PAST
function isPastMeeting(meeting: GranolaDoc): boolean {
  const meetingTime = new Date(meeting.created_at);
  return meetingTime < new Date();
}

// NORMALIZE ATTENDEE DATA FOR CONSISTENT FORMATTING
function normalizeAttendee(attendee: {
  name?: string;
  email?: string;
}): string {
  const hasValidName = attendee.name && attendee.name !== "undefined";
  return hasValidName
    ? `${attendee.name} <${attendee.email}>`
    : attendee.email || "";
}

// CREATE OR APPEND TO 1:1 MEETING FILE
async function handleOneOnOneMeeting(
  data: MeetingData,
  personName: string,
  force: boolean = false,
): Promise<{ success: boolean; action: string; filePath?: string }> {
  const oneOnOneFilename = `1 <> 1 ${personName}.md`;
  const oneOnOnePath = join(VAULT_PATH, "1 <> 1", oneOnOneFilename);

  const dateStr = data.startTime.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

  try {
    await access(oneOnOnePath);
    // File exists - check if already synced
    const content = await readFile(oneOnOnePath, "utf-8");
    const parsed = matter(content);

    const syncedMeetings = parsed.data.synced_meetings || [];
    if (syncedMeetings.includes(data.id) && !force) {
      return {
        success: false,
        action: `Already synced to 1 <> 1 ${personName}`,
        filePath: oneOnOnePath,
      };
    }

    // Append to it

    // Create new section for this meeting
    const newSection = `## [[${dateStr}]]

${data.panelContent || ""}
\n---\n`;

    // Insert after the button (find button and insert after it)
    const updatedContent = parsed.content.replace(
      /(\`\`\`meta-bind-button[\s\S]*?\`\`\`)\n/,
      `$1\n${escapeReplacement(newSection)}`,
    );

    // Track this synced meeting ID
    if (!syncedMeetings.includes(data.id)) {
      syncedMeetings.push(data.id);
    }
    parsed.data.synced_meetings = syncedMeetings;

    const updated = matter.stringify(updatedContent, parsed.data);
    await writeFile(oneOnOnePath, updated, "utf-8");
    await logToDaily(data.startTime, "Appended to", `1 <> 1 ${personName}`);
    return {
      success: true,
      action: `Appended to [[1 <> 1 ${personName}]]`,
      filePath: oneOnOnePath,
    };
  } catch (error) {
    // File doesn't exist - create it
    const frontmatter: { collections: string[]; synced_meetings?: string[] } = {
      collections: ["[[1 <> 1]]", "[[Meetings]]"],
    };

    const newContent = `# [[${personName}]]

\`\`\`meta-bind-button
style: primary
label: Add Meeting Notes
id: meeting
action:
  type: "replaceSelf"
  replacement: x/Templates/1 <> 1 Recurring Section Template
  templater: true
\`\`\`
## [[${dateStr}]]

${data.panelContent || ""}
`;

    frontmatter.synced_meetings = [data.id];
    const markdown = matter.stringify(newContent, frontmatter);
    await mkdir(dirname(oneOnOnePath), { recursive: true });
    await writeFile(oneOnOnePath, markdown, "utf-8");
    await logToDaily(data.startTime, "Created", `1 <> 1 ${personName}`);
    return {
      success: true,
      action: `Created new 1 <> 1 ${personName}`,
      filePath: oneOnOnePath,
    };
  }
}

// CREATE OR APPEND TO RECURRING MEETING FILE
async function handleRecurringMeeting(
  data: MeetingData,
  meetingName: string,
  force: boolean = false,
): Promise<{ success: boolean; action: string; filePath?: string }> {
  const recurringFilename = `${meetingName}.md`;
  const recurringPath = join(VAULT_PATH, "Recurring", recurringFilename);

  const dateStr = data.startTime.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

  try {
    await access(recurringPath);
    // File exists - check if already synced
    const content = await readFile(recurringPath, "utf-8");
    const parsed = matter(content);

    const syncedMeetings = parsed.data.synced_meetings || [];
    if (syncedMeetings.includes(data.id) && !force) {
      return {
        success: false,
        action: `Already synced to ${meetingName}`,
        filePath: recurringPath,
      };
    }

    // Create new section for this meeting
    const newSection = `# ${dateStr}

${data.panelContent || ""}

---\n`;

    // Insert after the button (find button and insert after it)
    const updatedContent = parsed.content.replace(
      /(\`\`\`meta-bind-button[\s\S]*?\`\`\`)\n/,
      `$1\n${escapeReplacement(newSection)}`,
    );

    // Track this synced meeting ID
    if (!syncedMeetings.includes(data.id)) {
      syncedMeetings.push(data.id);
    }
    parsed.data.synced_meetings = syncedMeetings;

    const updated = matter.stringify(updatedContent, parsed.data);
    await writeFile(recurringPath, updated, "utf-8");
    await logToDaily(data.startTime, "Appended to", meetingName);
    return {
      success: true,
      action: `Appended to [[${meetingName}]]`,
      filePath: recurringPath,
    };
  } catch (error) {
    // File doesn't exist - create it
    const frontmatter: { collections: string[]; synced_meetings?: string[] } = {
      collections: ["[[Recurring]]", "[[Meetings]]"],
    };

    const newContent = `# ${meetingName}

\`\`\`meta-bind-button
style: primary
label: Add Meeting Notes
id: meeting
action:
  type: "replaceSelf"
  replacement: x/Templates/1 <> 1 Recurring Section Template
  templater: true
\`\`\`
# ${dateStr}

${data.panelContent || ""}
`;

    frontmatter.synced_meetings = [data.id];
    const markdown = matter.stringify(newContent, frontmatter);
    await mkdir(dirname(recurringPath), { recursive: true });
    await writeFile(recurringPath, markdown, "utf-8");
    await logToDaily(data.startTime, "Created recurring", meetingName);
    return {
      success: true,
      action: `Created new recurring: ${meetingName}`,
      filePath: recurringPath,
    };
  }
}

// CREATE AD HOC MEETING FILE
async function handleAdHocMeeting(
  data: MeetingData,
): Promise<{ success: boolean; action: string; filePath?: string }> {
  const pacificDateStr = data.startTime.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });

  const cleanTitle = data.title
    .replace(/\//g, "･")
    .replace(/\\/g, "･")
    .replace(/:/g, "：")
    .replace(/\*/g, "✱")
    .replace(/\?/g, "？")
    .replace(/"/g, "'")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim();

  const filename = `${pacificDateStr} - ${cleanTitle}.md`;
  const filePath = join(VAULT_PATH, "Ad-hoc", filename);

  // Extract attendee names
  const attendeeNames = data.attendees.map((a) => a.split(" <")[0]);

  const frontmatter = {
    collections: ["[[Ad-hoc]]", "[[Meetings]]"],
    type: "meeting",
    created: data.startTime.toISOString().split("T")[0],
    start_time: data.startTime.toISOString(),
    end_time: data.endTime?.toISOString() || "",
    attendees: attendeeNames,
    source: "granola",
    calendar_event_id: data.id
  };

  const content = `# ${data.title}

## Summary

${data.panelContent || ""}
${shouldSyncTranscript(data.title) && data.transcript ? `\n## Transcript\n${data.transcript}` : ""}`;

  const markdown = matter.stringify(content, frontmatter);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, "utf-8");
  const displayName = `${pacificDateStr} - ${cleanTitle}`;
  await logToDaily(data.startTime, "Created ad hoc", displayName);

  return { success: true, action: `Created ad hoc: ${cleanTitle}`, filePath };
}

// DAILY NOTE LOGGING
async function logToDaily(
  date: Date,
  action: string,
  targetName: string,
): Promise<void> {
  const daysPath = join(VAULT_ROOT, "Calendar", "Days");

  const dateStr = date.toLocaleDateString("en-CA", {
    timeZone: "America/Los_Angeles",
  });
  const dailyNotePath = join(daysPath, `${dateStr}.md`);

  // Create "Synced Meetings" section entry
  const logEntry = `- ${action} [[${targetName}]]`;

  try {
    // Try to read existing daily note
    const content = await readFile(dailyNotePath, "utf-8");
    const parsed = matter(content);

    // Check if entry already exists (exact match with action and targetName)
    if (parsed.content.includes(logEntry)) {
      // Entry already exists, don't add duplicate
      return;
    }

    // Check if "Synced Meetings" section exists
    if (parsed.content.includes("# Synced Meetings")) {
      // Append to existing section
      const updated = parsed.content.replace(
        /(# Synced Meetings\n)/,
        `$1${escapeReplacement(logEntry)}\n`,
      );
      const markdown = matter.stringify(updated, parsed.data);
      await writeFile(dailyNotePath, markdown, "utf-8");
    } else {
      // Add new section
      const synced = `\n# Synced Meetings\n${logEntry}\n`;
      const updated = parsed.content + synced;
      const markdown = matter.stringify(updated, parsed.data);
      await writeFile(dailyNotePath, markdown, "utf-8");
    }
  } catch (error) {
    // Daily note doesn't exist - create it using template
    try {
      const templatePath = join(
        VAULT_ROOT,
        "x",
        "Templates",
        "Periodic Notes - Daily Template.md",
      );
      const templateContent = await readFile(templatePath, "utf-8");
      const parsed = matter(templateContent);

      // Create new daily note with date substitution
      const newFrontmatter = { ...parsed.data, created: dateStr };
      let newContent = parsed.content;

      // Add Synced Meetings section before Quick Capture
      newContent = newContent.replace(
        /(## Quick Capture)/,
        `## Synced Meetings\n${escapeReplacement(logEntry)}\n\n$1`,
      );

      const markdown = matter.stringify(newContent, newFrontmatter);
      await mkdir(dirname(dailyNotePath), { recursive: true });
      await writeFile(dailyNotePath, markdown, "utf-8");
    } catch (templateError) {
      console.warn(
        `Could not create daily note for ${dateStr}:`,
        templateError,
      );
    }
  }
}

// FETCH WITH TIMEOUT
function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
  label?: string,
): Promise<Response> {
  const timeout = options.timeout || 30000; // Default 30 seconds
  const controller = new AbortController();
  if (config.debug && label) console.log(`  → Calling ${label}...`);
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timeoutId),
  );
}

// PANEL API FUNCTION
async function getPanels(documentId: string, token: string): Promise<Panel[]> {
  const response = await fetchWithTimeout(
    `${API_BASE}/get-document-panels`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document_id: documentId }),
      timeout: 30000,
    },
    "get-document-panels",
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch panels: ${response.status}`);
  }

  return await response.json();
}

// MAIN SYNC FUNCTION
async function main(): Promise<void> {
  if (!hasNetworkConnection()) {
    await log("⚠️  No network connection detected - skipping sync");
    process.exit(0);
  }

  await log("Starting sync with future meetings...");

  // 1. INDEX EXISTING VAULT MEETINGS
  console.log("\n📁 Indexing existing vault meetings...");
  const existingMeetings = await indexVaultMeetings(
    VAULT_PATH,
    true,
    config.debug,
  );
  console.log(`   Found ${existingMeetings.length} existing meetings`);

  // 2. GET AUTH TOKEN
  console.log("\n🔑 Loading auth token...");
  let token: string | undefined;
  const tokenData = JSON.parse(await readFile(TOKEN_PATH, "utf-8"));

  // Try to get token from access_token field
  if (tokenData.access_token) {
    token = tokenData.access_token;
  } else if (
    typeof tokenData.cognito_tokens === "string" &&
    tokenData.cognito_tokens.length > 0
  ) {
    // Try parsing cognito_tokens as JSON
    try {
      const cognitoTokens = JSON.parse(tokenData.cognito_tokens);
      if (cognitoTokens.access_token) {
        token = cognitoTokens.access_token;
      }
    } catch (e) {
      // If parsing cognito_tokens as JSON fails, assume it's the token itself
      token = tokenData.cognito_tokens;
    }
  } else if (
    typeof tokenData.workos_tokens === "string" &&
    tokenData.workos_tokens.length > 0
  ) {
    try {
      const workosTokens = JSON.parse(tokenData.workos_tokens);
      if (workosTokens.access_token) {
        token = workosTokens.access_token;
      }
    } catch (e) {
      // If parsing workos_tokens as JSON fails, assume workos_tokens itself is the token.
      token = tokenData.workos_tokens;
    }
  }

  if (!token) throw new Error("No auth token found");

  // 3. FETCH PAST/PROCESSED MEETINGS FROM API
  console.log("\n📥 Fetching processed meetings from API..." + (isForceMode && forceDocumentId ? ` (force mode for ${forceDocumentId})` : ""));
  const docsResponse = await fetchWithTimeout(
    `${API_BASE}/get-documents`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: config.meetingsLimit }),
      timeout: 30000,
    },
    "get-documents",
  );

  if (!docsResponse.ok) {
    const error = `Docs API failed: ${docsResponse.status} ${docsResponse.statusText}`;
    sendPushover("Granola Sync FAILED", error);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  const allMeetings: GranolaDoc[] = await docsResponse.json();
  console.log(`   Found ${allMeetings.length} processed meetings`);

  const meetings = isForceMode && forceDocumentId
    ? allMeetings.filter((m) => m.id === forceDocumentId)
    : allMeetings;

  if (isForceMode && forceDocumentId && meetings.length === 0) {
    const error = `No meetings found matching forced document id: ${forceDocumentId}`;
    await logError(error);
    return;
  }

  // API should ALWAYS return past meetings
  if (meetings.length === 0) {
    const error = "API returned 0 meetings - API is likely broken";
    sendPushover("Granola Sync FAILED", error);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  let processedCount = 0;
  let skippedCount = 0;
  const newlyProcessedMeetings: { filePath: string; data: MeetingData }[] = [];

  // 4. PROCESS PAST MEETINGS (FILED MEETINGS WITH DEDUPLICATION)
  console.log("\n📝 Processing past meetings...");
  for (const meeting of meetings) {
    // Check if meeting was deleted (in trash)
    const existingMeeting = existingMeetings.find((em) => em.id === meeting.id);

    if (existingMeeting?.isDeleted) {
      if (config.debug)
        console.log(`🗑️  Skipping deleted: ${ensureTitle(meeting.title)}`);
      continue;
    }

    // CATEGORIZE MEETING FIRST (before duplicate check) - so we know what type it should be
    const category = categorizeMeeting(ensureTitle(meeting.title));

    // Check if we already have a filed meeting with this Granola ID (any status)
    const existingFiledMeeting = existingMeetings.find(
      (em) => em.id === meeting.id && !em.isDeleted,
    );

    if (!isForceMode) {
      // For 1:1 and recurring meetings, allow reprocessing even if it exists as ad-hoc
      // This handles cases where a meeting was previously created as ad-hoc but should be in a 1:1 or recurring file
      if (existingFiledMeeting && category.type === "adHoc") {
        // Only skip ad-hoc meetings that already exist
        console.log(`⏭️  Already exists: ${ensureTitle(meeting.title)}`);
        continue;
      }

      // Also skip if any meeting type already exists
      if (
        existingFiledMeeting &&
        existingFiledMeeting.id === meeting.id &&
        category.type !== "adHoc"
      ) {
        if (config.debug)
          console.log(`Already synced: ${ensureTitle(meeting.title)}`);
        continue;
      }
    }

    // Note: 1:1 and recurring meetings will proceed even if they exist as ad-hoc,
    // and they'll be added to the correct 1:1/recurring file via handleOneOnOneMeeting/handleRecurringMeeting

    // Check if meeting has panels (required for sync)
    let panels: Panel[] = [];
    try {
      if (config.debug)
        console.log(`    Fetching panels for: ${ensureTitle(meeting.title)}`);
      panels = await getPanels(meeting.id, token);
    } catch (error) {
      console.log(
        `⚠️  Failed to fetch panels for ${ensureTitle(meeting.title)} - skipping`,
      );
      continue;
    }

    if (!panels || panels.length === 0) {
      if (config.debug)
        console.log(`⏳ No panels yet: ${ensureTitle(meeting.title)}`);
      continue;
    }

    // Ensure summarization has completed: require at least one non-empty panel
    // Granola's API does not expose an explicit "done" flag; in practice, panels
    // are only created once summarization has run. We therefore treat any
    // non-empty panel as evidence the summary is ready.
    const summaryPanelReady = panels.some(
      (p) =>
        typeof p.original_content === "string" &&
        p.original_content.trim().length > 0,
    );

    if (!summaryPanelReady) {
      if (config.debug)
        console.log(
          `⏳ Summary panel not ready yet: ${ensureTitle(meeting.title)}`,
        );
      continue;
    }

    // Fetch metadata and transcript (used for attendee info and transcript content)
    if (config.debug)
      console.log(
        `    Fetching metadata & transcript for: ${ensureTitle(meeting.title)}`,
      );
    const [metaResponse, transcriptResponse] = await Promise.all([
      fetchWithTimeout(
        `${API_BASE}/get-document-metadata`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ document_id: meeting.id }),
          timeout: 30000,
        },
        "get-document-metadata",
      ),
      fetchWithTimeout(
        `${API_BASE}/get-document-transcript`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ document_id: meeting.id }),
          timeout: 30000,
        },
        "get-document-transcript",
      ),
    ]);

    if (!metaResponse.ok || !transcriptResponse.ok) {
      const error = `Failed to fetch data for ${ensureTitle(meeting.title)} - skipping`;
      console.error(error);
      sendPushover("Granola Sync Warning", error);
      continue;
    }

    const metadata: DocMetadata = await metaResponse.json();
    const transcriptData = await transcriptResponse.json();

    // Filter out solo/empty meetings
    const processedTranscript = processTranscript(transcriptData);
    const skipCheck = shouldSkipPastMeeting({
      attendees: metadata.attendees || [],
      transcript: processedTranscript,
      title: ensureTitle(meeting.title),
    });

    if (skipCheck.skip) {
      console.log(
        `⏭️  Skipping past meeting: ${ensureTitle(meeting.title)} (${skipCheck.reason})`,
      );
      skippedCount++;
      continue;
    }

    // Only do full transcript processing if we're syncing transcripts for this meeting
    const finalTranscript = shouldSyncTranscript(ensureTitle(meeting.title))
      ? processedTranscript
      : "";

    // Fallback: if title indicates a 1:1 but we didn't get a unique
    // mapping from meeting-mappings.json, try to infer the partner
    // from attendee metadata (non-owner attendee).
    let effectiveCategory = category;
    const isLikelyOneOnOne =
      isOneOnOneTitle(ensureTitle(meeting.title)) || isOneOnOneByFolder(meeting);

    if (
      category.type === "adHoc" &&
      isLikelyOneOnOne &&
      metadata.attendees &&
      metadata.attendees.length > 0
    ) {
      const attendeeCategory = categorizeOneOnOneFromMetadata(metadata);
      if (attendeeCategory) {
        effectiveCategory = attendeeCategory;
        if (config.debug) {
          console.log(
            `🔁 Reclassified as 1:1 based on attendees: ${
              attendeeCategory.targetName
            } (${ensureTitle(meeting.title)})`,
          );
        }
      }
    }

    // CONTENT VALIDATION FOR PAST MEETINGS - Skip empty meetings
    if (isPastMeeting(meeting)) {
      if (!hasContent(transcriptData, panels)) {
        console.log(
          `⏭️  Skipping empty: ${ensureTitle(meeting.title)} (0 segments, ${panels.length} panels)`,
        );
        skippedCount++;
        continue;
      }
    }

    // Panel processing using already fetched panels
    let panelContent = "";
    try {
      if (panels && panels.length > 0) {
        // Sort panels: specified template first
        const sortedPanels = panels.sort(
          (a, b) =>
            (b.template_slug === TEMPLATE_SLUG ? 1 : 0) -
            (a.template_slug === TEMPLATE_SLUG ? 1 : 0),
        );
        panelContent = processPanels(sortedPanels);
      }
    } catch (error) {
      console.error(
        `Failed to process panels for "${ensureTitle(meeting.title)}":`,
        error,
      );
      // Continue without panels - don't break existing functionality
    }

    // Normalize data for shared function
    const meetingData: MeetingData = {
      id: meeting.id,
      title: ensureTitle(meeting.title),
      startTime: new Date(meeting.created_at),
      attendees:
        metadata.attendees?.map(normalizeAttendee).filter(Boolean) || [],
      organizer: metadata.creator?.name || "",
      location: "",
      status: "filed",
      transcript: finalTranscript,
      panelContent: panelContent,
    };

    // category was determined earlier and may have been refined using metadata
    let result: { success: boolean; action?: string; filePath?: string };

    if (effectiveCategory.type === "oneOnOne" && effectiveCategory.targetName) {
      result = await handleOneOnOneMeeting(
        meetingData,
        effectiveCategory.targetName,
        isForceMode,
      );
    } else if (effectiveCategory.type === "recurring" && effectiveCategory.targetName) {
      result = await handleRecurringMeeting(
        meetingData,
        effectiveCategory.targetName,
        isForceMode,
      );
    } else {
      // Ad hoc meeting
      result = await handleAdHocMeeting(meetingData);
    }

    if (result.success && result.filePath) {
      processedCount++;
      console.log(`${result.action}`);
      newlyProcessedMeetings.push({
        filePath: result.filePath,
        data: meetingData,
      });
    }
  }

  // 5. PROCESS NEWLY SYNCED MEETINGS
  if (config.enableMeetingProcessing && newlyProcessedMeetings.length > 0) {
    console.log(
      `\n🤖 Processing ${newlyProcessedMeetings.length} newly synced meetings...`,
    );
    await processSingleMeeting();
  }

  // 6. SUCCESS MESSAGE
  await log(`\nSUCCESS: ${processedCount} meetings processed`);
  if (skippedCount > 0) {
    await log(
      `⏭️  Skipped: ${skippedCount} empty meetings (no transcript or panels)`,
    );
  }

  // Reset failure count on success
  await resetFailureCount();
}

// EXECUTION
main().catch(async (error) => {
  // Check network first - don't report errors if offline
  if (!hasNetworkConnection()) {
    await logError("Sync failed due to no network connection");
    process.exit(1);
  }

  // Increment failure count
  const failureCount = await incrementFailureCount();

  // Format error message
  let errorMessage = "";
  if (error instanceof Error) {
    const code = (error as any).code ? ` [code: ${(error as any).code}]` : "";
    errorMessage = `${error.name}: ${error.message}${code}`;
  } else if (typeof error === "object" && error !== null) {
    const name = (error as any).name || "Error";
    const message = (error as any).message || "Unknown error";
    const code = (error as any).code ? ` [code: ${(error as any).code}]` : "";
    errorMessage = `${name}: ${message}${code}`;
  } else {
    errorMessage = String(error);
  }

  await logError(`SYNC FAILED (attempt ${failureCount}): ${errorMessage}`);

  // Only send Pushover notification after 3 consecutive failures
  if (failureCount >= 3) {
    sendPushover(
      "Granola Sync CRASHED (3x failures)",
      `Sync has failed 3 times in a row.\n\nLatest error: ${errorMessage}`,
    );
  }

  // Give Pushover time to send before exiting
  setTimeout(() => process.exit(1), 1000);
});
