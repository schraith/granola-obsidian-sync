#!/usr/bin/env bun

import 'dotenv/config';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';

// --- CONFIGURATION ---
// All user-configurable values are sourced from environment variables.
// See .env.example for details.

const requiredEnvVars = [
  'GRANOLA_AUTH_PATH',
  'OBSIDIAN_VAULT_MEETINGS_PATH',
  'CACHE_DIR_PATH',
];

// Helper to resolve tilde (~) in paths
const resolvePath = (p: string) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

// Validate required environment variables
for (const varName of requiredEnvVars) {
  if (!process.env[varName]) {
    throw new Error(`Missing required environment variable: ${varName}. Please copy .env.example to .env and set this value.`);
  }
}

const config = {
  granolaAuthPath: resolvePath(process.env.GRANOLA_AUTH_PATH!),
  obsidianVaultPath: resolvePath(process.env.OBSIDIAN_VAULT_MEETINGS_PATH!),
  cachePath: join(resolvePath(process.env.CACHE_DIR_PATH!), 'cache-v3.json'),
  meetingsLimit: parseInt(process.env.GRANOLA_MEETINGS_LIMIT || '50'),
  // Pushover config for future use
  pushover: {
    userKey: process.env.PUSHOVER_USER_KEY,
    apiToken: process.env.PUSHOVER_API_TOKEN,
  },
};

// --- END CONFIGURATION ---

const API_BASE = 'https://api.granola.ai/v1';
const VAULT_PATH = config.obsidianVaultPath;
const TOKEN_PATH = config.granolaAuthPath;
const CACHE_PATH = config.cachePath;

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

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  organizer?: { email: string };
  attendees?: Array<{ email: string; displayName?: string }>;
  description?: string;
  location?: string;
  conferenceData?: any;
  status: string;
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
  status: 'filed' | 'scheduled';
  transcript?: string;
  meetingUrl?: string;
  durationMin?: number;
}

// PUSHOVER NOTIFICATION - FIRE AND FORGET
function sendPushover(title: string, message: string): void {
  if (!config.pushover.userKey || !config.pushover.apiToken) return;
  
  fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: config.pushover.apiToken,
      user: config.pushover.userKey,
      title,
      message,
      priority: '1'
    })
  }).catch(err => {
    console.error(`Pushover failed: ${err.message}`);
  });
}

// SIMPLIFIED CACHE PARSING - NO RECURSIVE FALLBACK
async function extractEventsFromCache(): Promise<CalendarEvent[]> {
  const cacheContent = await readFile(CACHE_PATH, 'utf-8');
  
  try {
    const cacheData = JSON.parse(cacheContent);
    if (!cacheData.cache) {
      console.warn('Warning: "cache" key not found in cache file. No future events will be processed.');
      return [];
    }
    
    const innerData = JSON.parse(cacheData.cache);
    if (innerData.state?.events && Array.isArray(innerData.state.events)) {
      return innerData.state.events.filter((e: any) => e?.kind === 'calendar#event');
    }
    
    console.warn('Warning: Could not find "state.events" array in cache. No future events will be processed.');
    return [];
  } catch (e) {
    console.error('Error parsing cache:', e);
    return []; // Return empty on parsing error to avoid crashing the whole sync
  }
}

// SHARED FUNCTION TO PROCESS AND WRITE MEETINGS
async function processAndWriteMeeting(data: MeetingData): Promise<boolean> {
  const date = data.startTime;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthName = date.toLocaleDateString('en-US', { month: 'long' });
  const dateStr = date.toISOString().split('T')[0] + ' ' + 
                 date.toTimeString().slice(0, 5).replace(':', '-');

  const cleanTitle = data.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
  const shortId = data.id.substring(0, 8);
  const filename = `${dateStr} ${cleanTitle} -- ${shortId}.md`;
  const filePath = join(VAULT_PATH, String(year), `${month}-${monthName}`, filename);

  // Skip if file exists
  try {
    await access(filePath);
    return false;
  } catch {
    // File doesn't exist, continue
  }

  // Create frontmatter
  const frontmatter = {
    title: data.title,
    date: data.startTime.toISOString().split('T')[0],
    attendees: data.attendees,
    organizer: data.organizer,
    location: data.location,
    start_time: data.startTime.toISOString(),
    end_time: data.endTime?.toISOString() || '',
    duration_min: data.durationMin || 0,
    area: '',
    source: 'granola',
    status: data.status,
    privacy: 'internal',
    calendar_event_id: data.id,
    meeting_url: data.meetingUrl || ''
  };

  // Create content based on status
  const content = data.status === 'filed' && data.transcript
    ? `# ${data.title}

## Summary

## Transcript
${data.transcript}`
    : `# ${data.title}

## Agenda

## Notes

## Action Items
`;
  
  const markdown = matter.stringify(content, frontmatter);
  
  // Write file
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, 'utf-8');
  
  console.log(data.status === 'filed' ? `✓ ${data.title}` : `📅 ${data.title} (${dateStr})`);
  return true;
}

// MAIN SYNC FUNCTION
async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Starting sync with future meetings...`);

  // 1. GET AUTH TOKEN
  const tokenData = JSON.parse(await readFile(TOKEN_PATH, 'utf-8'));
  const tokens = JSON.parse(tokenData.workos_tokens);
  const token = tokens.access_token;
  
  if (!token) throw new Error('No auth token found');

  // 2. FETCH PAST/PROCESSED MEETINGS FROM API
  console.log('\n📥 Fetching processed meetings from API...');
  const docsResponse = await fetch(`${API_BASE}/get-documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ limit: config.meetingsLimit })
  });

  if (!docsResponse.ok) {
    const error = `Docs API failed: ${docsResponse.status} ${docsResponse.statusText}`;
    sendPushover('Granola Sync FAILED', error);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  const meetings: GranolaDoc[] = await docsResponse.json();
  console.log(`   Found ${meetings.length} processed meetings`);

  // API should ALWAYS return past meetings
  if (meetings.length === 0) {
    const error = 'API returned 0 meetings - API is likely broken';
    sendPushover('Granola Sync FAILED', error);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for Pushover
    throw new Error(error);
  }

  let processedCount = 0;
  let futureCount = 0;

  // 3. PROCESS PAST MEETINGS
  console.log('\n📝 Processing past meetings...');
  for (const meeting of meetings) {
    // Fetch metadata and transcript first (to avoid unnecessary API calls if file exists)
    const [metaResponse, transcriptResponse] = await Promise.all([
      fetch(`${API_BASE}/get-document-metadata`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ document_id: meeting.id })
      }),
      fetch(`${API_BASE}/get-document-transcript`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ document_id: meeting.id })
      })
    ]);

    if (!metaResponse.ok || !transcriptResponse.ok) {
      const error = `Failed to fetch data for ${meeting.title} - skipping`;
      console.error(error);
      sendPushover('Granola Sync Warning', error);
      continue;
    }

    const metadata: DocMetadata = await metaResponse.json();
    const transcriptData = await transcriptResponse.json();
    
    // Normalize data for shared function
    const meetingData: MeetingData = {
      id: meeting.id,
      title: meeting.title,
      startTime: new Date(meeting.created_at),
      attendees: metadata.attendees?.map(a => a.name || a.email || 'Unknown').filter(Boolean) || [],
      organizer: metadata.creator?.name || '',
      location: '',
      status: 'filed',
      transcript: transcriptData.transcript || ''
    };
    
    if (await processAndWriteMeeting(meetingData)) {
      processedCount++;
    }
  }

  // 4. PROCESS FUTURE MEETINGS FROM CACHE
  console.log('\n📅 Processing future meetings from cache...');
  try {
    const events = await extractEventsFromCache();
    console.log(`   Found ${events.length} calendar events in cache`);
    
    const now = new Date();
    const futureEvents = events.filter(e => {
      if (!e.start?.dateTime) return false;
      const eventDate = new Date(e.start.dateTime);
      return eventDate > now && e.status !== 'cancelled';
    });
    
    console.log(`   ${futureEvents.length} are future meetings`);
    
    for (const event of futureEvents) {
      const startTime = new Date(event.start.dateTime);
      const endTime = event.end?.dateTime ? new Date(event.end.dateTime) : undefined;
      
      // Extract meeting URL if available
      let meetingUrl = '';
      if (event.conferenceData?.entryPoints) {
        const videoEntry = event.conferenceData.entryPoints.find((e: any) => e.entryPointType === 'video');
        if (videoEntry) meetingUrl = videoEntry.uri;
      }
      
      // Normalize data for shared function
      const meetingData: MeetingData = {
        id: event.id,
        title: event.summary || 'Untitled Meeting',
        startTime,
        endTime,
        attendees: event.attendees?.map(a => a.displayName || a.email || 'Unknown').filter(Boolean) || [],
        organizer: event.organizer?.email || '',
        location: event.location || '',
        status: 'scheduled',
        meetingUrl,
        durationMin: endTime ? Math.round((endTime.getTime() - startTime.getTime()) / 60000) : 60
      };
      
      if (await processAndWriteMeeting(meetingData)) {
        futureCount++;
      }
    }
  } catch (error) {
    console.error('⚠️  Error processing future meetings:', error);
  }

  // 5. SUCCESS MESSAGE
  const endTimestamp = new Date().toISOString();
  console.log(`\n[${endTimestamp}] SUCCESS: ${processedCount} past meetings, ${futureCount} future meetings synced`);
}

// EXECUTION
main().catch(error => {
  const errorTimestamp = new Date().toISOString();
  console.error(`[${errorTimestamp}] === SYNC FAILED ===`);
  console.error(error);
  console.error('===================');
  
  // Send Pushover with stack trace
  const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
  sendPushover('Granola Sync CRASHED', `Script crashed at ${errorTimestamp}\n\n${errorMessage}`);
  
  // Give Pushover time to send before exiting
  setTimeout(() => process.exit(1), 1000);
});