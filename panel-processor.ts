import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced'
});

interface Panel {
  original_content: string;
  template_slug: string;
}

interface PanelSection {
  title: string;
  content: string; // Markdown content
}

/**
 * Extracts H3-demarcated sections from a single panel's HTML content.
 * @param panel - The panel object from the API.
 * @returns An array of PanelSection objects.
 */
function extractSectionsFromPanel(panel: Panel): PanelSection[] {
  const sections: PanelSection[] = [];
  if (!panel.original_content) {
    return sections;
  }

  const $ = cheerio.load(panel.original_content);
  const h3s = $('h3');

  h3s.each((index, h3Element) => {
    const title = $(h3Element).text().trim();
    
    // Select all sibling elements between this h3 and the next h3
    const contentElements = $(h3Element).nextUntil('h3');
    
    // Get the combined outer HTML of these elements
    const contentHtml = contentElements.map((i, el) => $.html(el)).get().join('');
    
    // Convert just this section's HTML to Markdown
    const contentMarkdown = turndownService.turndown(contentHtml).trim();

    // Only add the section if it has a title and some content
    if (title && contentMarkdown) {
      sections.push({ title, content: contentMarkdown });
    }
  });

  return sections;
}

/**
 * Processes an array of panels, extracting their H3 sections into a single Markdown string.
 * @param panels - A sorted array of panel objects (Josh Template first).
 * @returns A single string of Markdown content with H3 headers.
 */
export function processPanels(panels: Panel[]): string {
  if (!panels || panels.length === 0) {
    return '';
  }

  // Use flatMap to process all panels and flatten the sections into a single array
  const allSections = panels.flatMap(panel => extractSectionsFromPanel(panel));

  const markdownSections = allSections.map(section => {
    return `### ${section.title}\n${section.content}`;
  });

  // Join with extra newlines for proper spacing between sections
  return markdownSections.join('\n\n');
}