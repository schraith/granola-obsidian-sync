import TurndownService from 'turndown';
import * as cheerio from 'cheerio';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced'
});

// Override default list item handling to use single space
turndownService.addRule('listItem', {
  filter: 'li',
  replacement(content, node, options) {
    content = content.replace(/^\s+/, '').replace(/\s+$/, '').replace(/\n/gm, '\n  ');
    let prefix = options.bulletListMarker + ' ';
    let parent = node.parentNode as any;
    if (parent.name === 'ol') {
      const start = parent.attribs?.start ? parseInt(parent.attribs.start) : 1;
      const index = Array.from(parent.children || []).indexOf(node);
      prefix = (start + index) + '. ';
    }
    return prefix + content + '\n';
  }
});

// Add rule for list items with checkboxes (must be before default li rule)
turndownService.addRule('checklistItem', {
  filter(node) {
    if (node.name !== 'li') return false;
    const input = node.children?.find((child: any) => child.name === 'input' && child.attribs?.type === 'checkbox');
    return !!input;
  },
  replacement(content, node) {
    const input = node.children?.find((child: any) => child.name === 'input' && child.attribs?.type === 'checkbox') as any;
    const checked = input?.attribs?.checked !== undefined ? '[x]' : '[ ]';
    // Remove the checkbox input from content and clean up
    const text = content
      .replace(/<input[^>]*type="checkbox"[^>]*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim();
    return `- ${checked} ${text}\n`;
  }
});

// Add rule for checkboxes to prevent them from being rendered as text
turndownService.addRule('checkbox', {
  filter(node) {
    return node.name === 'input' && node.attribs?.type === 'checkbox';
  },
  replacement() {
    return '';
  }
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
  let result = markdownSections.join('\n\n');
  
  // Unescape checkbox brackets that may have been escaped
  result = result.replace(/\\\[ \\\]/g, '[ ]');  // \[ \] -> [ ]
  result = result.replace(/\\\[x\\\]/g, '[x]');  // \[x\] -> [x]
  
  // Fix multiple spaces in list items (both regular and checkboxes)
  result = result.replace(/^(-\s+)(\s{2,})/gm, '$1');  // Multiple spaces after dash
  result = result.replace(/^(-\s+\[[x\s]\])(\s{2,})/gm, '$1 ');  // Multiple spaces after checkbox
  
  return result;
}
