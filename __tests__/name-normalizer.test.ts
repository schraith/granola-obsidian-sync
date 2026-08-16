import { describe, expect, test } from "bun:test";
import { normalizeNames, normalizeNamesWithReport } from "../name-normalizer";

// Enough team context to satisfy every gated correction in the table.
const TEAM = "Speaker A: Kashish and Kavya are on the InstantSys side.";

describe("normalizeNames", () => {
  test("corrects unambiguous misspellings anywhere in the text", () => {
    expect(normalizeNames("Sorry, I didn't hear what you said, Chivi.")).toBe(
      "Sorry, I didn't hear what you said, Shivi.",
    );
    expect(normalizeNames("It's good to see Pritham coming up to speed.")).toBe(
      "It's good to see Pritam coming up to speed.",
    );
    expect(normalizeNames("the genesis issue reported by Kavia")).toBe(
      "the genesis issue reported by Kavya",
    );
  });

  test("matches case-insensitively and keeps surrounding punctuation", () => {
    expect(normalizeNames("chivi's branch and CHIVI's PR")).toBe(
      "Shivi's branch and Shivi's PR",
    );
  });

  test("respects word boundaries", () => {
    expect(normalizeNames("Chivious is not a person")).toBe(
      "Chivious is not a person",
    );
  });

  test("normalizes product and company spellings", () => {
    expect(normalizeNames("Factor Lab uses Instant Sys and Lang Fuse")).toBe(
      "FactorLab uses InstantSys and Langfuse",
    );
    expect(normalizeNames("their Simple 7 score")).toBe("their Simple7 score");
  });

  test("collapses a line-wrapped variant", () => {
    expect(normalizeNames("we talked to Factor\nLab about it")).toBe(
      "we talked to FactorLab about it",
    );
  });

  test("leaves already-canonical text untouched and reports nothing", () => {
    const input = "Shivi and Krishan shipped the FactorLab release.";
    const { text, replacements } = normalizeNamesWithReport(input);
    expect(text).toBe(input);
    expect(replacements).toEqual({});
  });
});

describe("gated corrections", () => {
  test("rewrites Christian to Krishan when teammates are present", () => {
    const input = `${TEAM} And Christian is working on the legacy code.`;
    expect(normalizeNames(input)).toContain("And Krishan is working on");
  });

  test("leaves Christian alone in notes with no team context", () => {
    const input = "The day before the Stanford camp is the Valley Christian five on five.";
    expect(normalizeNames(input)).toBe(input);
  });

  test("keeps except-listed phrases even when the gate passes", () => {
    const input = `${TEAM} Christian Earls made that block against Valley Christian, but Christian owns the API.`;
    const output = normalizeNames(input);
    expect(output).toContain("Christian Earls");
    expect(output).toContain("Valley Christian");
    expect(output).toContain("but Krishan owns the API");
  });

  test("uses the supplied context rather than the text being rewritten", () => {
    const summary = "Christian will finish the SSO fix.";
    expect(normalizeNames(summary)).toBe(summary);
    expect(normalizeNames(summary, `${summary}\n${TEAM}`)).toBe(
      "Krishan will finish the SSO fix.",
    );
  });

  test("folds the other Krishan variants", () => {
    expect(normalizeNames(`${TEAM} Thank you, Krishna, for explaining.`)).toContain(
      "Thank you, Krishan, for explaining.",
    );
    expect(normalizeNames(`${TEAM} Krishnan and Kishan are the same person.`)).toContain(
      "Krishan and Krishan are the same person.",
    );
  });
});

describe("protected regions", () => {
  test("does not rewrite inside URLs, emails, wikilinks or code", () => {
    const input = [
      "mail kevin@factorlab.com or see https://example.com/factor-lab/kavia",
      "the [[Kavia]] note and `Factor Lab` in code",
      "a [Factor Lab doc](https://docs.example.com/factor-lab)",
    ].join("\n");
    const output = normalizeNames(input);
    expect(output).toContain("kevin@factorlab.com");
    expect(output).toContain("https://example.com/factor-lab/kavia");
    expect(output).toContain("[[Kavia]]");
    expect(output).toContain("`Factor Lab`");
    expect(output).toContain("https://docs.example.com/factor-lab");
    // Link text outside the target is still corrected.
    expect(output).toContain("[FactorLab doc]");
  });
});

describe("reporting", () => {
  test("counts every replacement by variant", () => {
    const { replacements } = normalizeNamesWithReport(
      `${TEAM} Chivi and Chibi and Chivi again, plus Christian.`,
    );
    expect(replacements["Chivi → Shivi"]).toBe(2);
    expect(replacements["Chibi → Shivi"]).toBe(1);
    expect(replacements["Christian → Krishan"]).toBe(1);
  });
});

describe("bare hostnames", () => {
  test("leaves domains alone, including markdown link text", () => {
    const input = "see [cloud.factorlab.com](http://cloud.factorlab.com/) and factorlab.com";
    expect(normalizeNames(input)).toBe(input);
  });
});

describe("Parthh", () => {
  test("lengthens the short form and leaves the canonical spelling alone", () => {
    expect(normalizeNames("Parth can run the summary tool script")).toBe(
      "Parthh can run the summary tool script",
    );
    const canonical = "Parthh Dikshit owns that.";
    expect(normalizeNamesWithReport(canonical).replacements).toEqual({});
  });
});

describe("idempotence", () => {
  test("a correction can unlock a gated one in the same pass", () => {
    // "Vikash" -> "Vikas" is what puts a teammate in the note.
    const input = "Vikash said Christian owns the SSO fix.";
    expect(normalizeNames(input)).toBe("Vikas said Krishan owns the SSO fix.");
  });

  test("re-running changes nothing", () => {
    const once = normalizeNames("Vikash said Christian owns it, per Chivi and Parth.");
    expect(normalizeNamesWithReport(once).replacements).toEqual({});
  });
});
