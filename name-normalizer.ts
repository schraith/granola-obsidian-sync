#!/usr/bin/env bun

import "dotenv/config";

/**
 * Name Normalization for Granola to Obsidian Sync
 *
 * Granola's transcription mangles the same names the same way every time
 * (Chivi -> Shivi, Pritham -> Pritam, Christian -> Krishan). Granola's own
 * "Internal Jargon" setting only boosts recognition; it can't guarantee a
 * replacement and does nothing for notes already synced. This module fixes
 * them deterministically at ingest, and can backfill the existing vault.
 *
 * Corrections live in name-corrections.json. Run this file directly for a
 * dry-run report over the vault:
 *
 *   bun name-normalizer.ts            # report only
 *   bun name-normalizer.ts --apply    # rewrite the notes
 */

import { readFileSync, existsSync } from "fs";
import { readdir, readFile, writeFile } from "fs/promises";
import { join, dirname, relative } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

export interface NameCorrection {
  to: string;
  from: string[];
  requireContext?: string[];
  except?: string[];
  enabled?: boolean;
  note?: string;
}

interface CompiledCorrection {
  to: string;
  patterns: RegExp[];
  requireContext?: string[];
  exceptSources: string[];
}

// Regions that are never rewritten: fenced/inline code, URLs, email addresses,
// bare hostnames, [[wikilinks]] and markdown link targets. Rewriting a link
// target would break the link; rewriting factorlab.com would break the address.
const PROTECTED_SOURCES = [
  "```[\\s\\S]*?```",
  "`[^`\\n]*`",
  "https?://[^\\s)\\]]+",
  "\\[\\[[^\\]]*\\]\\]",
  "\\]\\([^)]*\\)",
  "[\\w.+-]+@[\\w-]+\\.[\\w.-]+",
  "[\\w-]+(?:\\.[\\w-]+)*\\.(?:com|net|org|io|ai|co|dev|app|cloud|edu|gov)\\b",
];

// Upper bound on the fixpoint loop below, so a pathological table can't spin.
const MAX_PASSES = 4;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Spaces in a variant match any run of whitespace, so a line-wrapped
// "Factor\nLab" is corrected too.
const variantPattern = (variant: string) =>
  new RegExp(`\\b${escapeRegex(variant.trim()).replace(/\\?\s+/g, "\\s+")}\\b`, "gi");

function loadCorrections(): NameCorrection[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), "name-corrections.json");
  if (!existsSync(path)) {
    console.warn("⚠️  name-corrections.json not found, skipping name normalization");
    return [];
  }
  // Malformed JSON is a bug, not a runtime condition - fail loud.
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  return parsed.corrections || [];
}

export const NAME_CORRECTIONS: NameCorrection[] = loadCorrections();

const COMPILED: CompiledCorrection[] = NAME_CORRECTIONS.filter(
  (c) => c.enabled !== false,
).map((c) => ({
  to: c.to,
  // Longest variant first so multi-word forms win over their own prefixes.
  patterns: [...c.from]
    .sort((a, b) => b.length - a.length)
    .map(variantPattern),
  requireContext: c.requireContext,
  exceptSources: (c.except || []).map(
    (phrase) => `\\b${escapeRegex(phrase.trim()).replace(/\\?\s+/g, "\\s+")}\\b`,
  ),
}));

/**
 * Run `transform` over every part of `text` that falls outside the given spans.
 */
function transformOutsideSpans(
  text: string,
  spanSources: string[],
  transform: (chunk: string) => string,
): string {
  const spans = new RegExp(spanSources.join("|"), "gi");
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(spans)) {
    const index = match.index ?? 0;
    result += transform(text.slice(cursor, index)) + match[0];
    cursor = index + match[0].length;
  }
  return result + transform(text.slice(cursor));
}

/**
 * Apply the correction table and report what changed.
 *
 * `context` is what gated corrections are tested against - pass the whole note
 * (title + summary + transcript) so a gate satisfied by the transcript also
 * unlocks the correction in the summary. Defaults to `text` itself.
 */
export function normalizeNamesWithReport(
  text: string,
  context: string = text,
): { text: string; replacements: Record<string, number> } {
  const replacements: Record<string, number> = {};
  if (!text) return { text: text || "", replacements };

  let result = text;

  // One correction can create the context another one is gated on: fixing
  // "Vikash" -> "Vikas" is what makes "Christian" -> "Krishan" eligible in the
  // same note. Repeat until nothing changes so the result is order-independent
  // and re-running is a no-op.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const haystack = `${context}\n${result}`.toLowerCase();
    let changedThisPass = false;

    for (const correction of COMPILED) {
      if (
        correction.requireContext &&
        !correction.requireContext.some((term) => haystack.includes(term.toLowerCase()))
      ) {
        continue;
      }

      result = transformOutsideSpans(
        result,
        [...PROTECTED_SOURCES, ...correction.exceptSources],
        (chunk) => {
          let out = chunk;
          for (const pattern of correction.patterns) {
            out = out.replace(pattern, (match) => {
              if (match === correction.to) return match; // already canonical
              const key = `${match} → ${correction.to}`;
              replacements[key] = (replacements[key] || 0) + 1;
              changedThisPass = true;
              return correction.to;
            });
          }
          return out;
        },
      );
    }

    if (!changedThisPass) break;
  }

  return { text: result, replacements };
}

/**
 * Apply the correction table to a block of meeting text.
 */
export function normalizeNames(text: string, context?: string): string {
  return normalizeNamesWithReport(text, context).text;
}

// BACKFILL CLI
// Rewrites the body of existing vault notes. Frontmatter is passed through
// byte-for-byte so nothing reformats YAML across hundreds of files.

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function splitFrontmatter(raw: string): { head: string; body: string } {
  const match = raw.match(FRONTMATTER);
  if (!match) return { head: "", body: raw };
  return { head: match[0], body: raw.slice(match[0].length) };
}

async function collectMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdown(full)));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files.sort();
}

async function backfill(apply: boolean, showSamples: boolean) {
  const resolvePath = (p: string) =>
    p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
  const root = process.env.OBSIDIAN_VAULT_ROOT_PATH;
  const meetings = process.env.OBSIDIAN_VAULT_MEETINGS_PATH;
  if (!root || !meetings) {
    throw new Error(
      "Missing OBSIDIAN_VAULT_ROOT_PATH / OBSIDIAN_VAULT_MEETINGS_PATH - backfill needs the same .env the sync uses.",
    );
  }
  const vaultPath = join(resolvePath(root), meetings);

  const files = await collectMarkdown(vaultPath);
  const totals: Record<string, number> = {};
  let changedFiles = 0;

  console.log(
    `${apply ? "✍️  Applying" : "🔍 Dry run"} over ${files.length} notes in ${vaultPath}\n`,
  );

  for (const file of files) {
    const raw = await readFile(file, "utf-8");
    const { head, body } = splitFrontmatter(raw);
    const { text, replacements } = normalizeNamesWithReport(body, raw);
    const entries = Object.entries(replacements);
    if (entries.length === 0) continue;

    changedFiles++;
    for (const [key, count] of entries) totals[key] = (totals[key] || 0) + count;

    const summary = entries
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} (${count})`)
      .join(", ");
    console.log(`  ${relative(vaultPath, file)}\n      ${summary}`);

    if (showSamples) {
      for (const line of text.split("\n")) {
        if (entries.some(([key]) => line.includes(key.split(" → ")[1]))) {
          console.log(`      | ${line.trim().slice(0, 160)}`);
          break;
        }
      }
    }

    if (apply) await writeFile(file, head + text, "utf-8");
  }

  console.log(`\n${"-".repeat(60)}`);
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  for (const [key, count] of ranked) {
    console.log(`  ${String(count).padStart(5)}  ${key}`);
  }
  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  console.log(
    `\n${total} replacement${total === 1 ? "" : "s"} across ${changedFiles} file${
      changedFiles === 1 ? "" : "s"
    }`,
  );
  if (!apply && total > 0) {
    console.log("Nothing written. Re-run with --apply to rewrite these notes.");
  }
}

if (import.meta.main) {
  await backfill(process.argv.includes("--apply"), process.argv.includes("--samples"));
}
