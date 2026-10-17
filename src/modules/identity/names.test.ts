import { describe, expect, it } from "vitest";
import { childByKey, familyByKey } from "@/modules/demo/fixtures/standard";
import { findLeaks } from "@/modules/agent/redact";
import { rosterFromDisplayName, tokenizeNames, namedTokens } from "./names";

/**
 * The prompt guard is what this module exists for, so the test is the guard: a family's own
 * sentence, tokenized, must pass `validatePromptTokensOnly`'s name check — and must still say
 * which child it is about.
 */
describe("names become the tokens the operational tables use", () => {
  it("replaces a child's first name with that child's token", () => {
    expect(tokenizeNames("Can Noah be dropped at grandma's at 5?")).toBe(
      "Can C2 be dropped at grandma's at 5?",
    );
  });

  it("replaces the label before the first name, so no initial is left behind", () => {
    expect(tokenizeNames("Noah O. is staying home")).toBe("C2 is staying home");
    expect(tokenizeNames("Mia R. and Noah")).toBe("C1 and C2");
  });

  it("replaces a guardian with their family's token", () => {
    const { guardian } = familyByKey("F2");
    expect(tokenizeNames(`${guardian.firstName} will collect them`)).toBe("F2 will collect them");
  });

  it("does not match a name inside another word", () => {
    expect(tokenizeNames("Available all afternoon")).toBe("Available all afternoon");
    expect(tokenizeNames("Lantana library")).toBe("Lantana library");
  });

  it("matches however a family types it", () => {
    expect(tokenizeNames("noah is sick")).toBe("C2 is sick");
    expect(tokenizeNames("NOAH is sick")).toBe("C2 is sick");
  });

  it("leaves a message naming nobody exactly as it was", () => {
    const text = "the van has not arrived yet";
    expect(tokenizeNames(text)).toBe(text);
  });

  it("clears the gateway's name check, which the untokenized text does not", () => {
    const raw = `${childByKey("C2").label} will not need the van`;
    expect(findLeaks(raw).some((f) => f.kind === "NAME")).toBe(true);
    expect(findLeaks(tokenizeNames(raw)).some((f) => f.kind === "NAME")).toBe(false);
  });

  it("says which people a message names, for a scope check", () => {
    expect(namedTokens("Can Noah be dropped at grandma's at 5?")).toEqual(["C2"]);
    expect(namedTokens("the van has not arrived yet")).toEqual([]);
  });
});

/**
 * The caller-supplied half of the mapping (Veri's agent gate, check 4): a demo deployment's own
 * `ops.child_profile.display_name`, which the fixture roster does not know. The assembler reads
 * the rows and passes them in; this is what it passes.
 */
describe("a deployment's own display names, mapped to the token the tables use", () => {
  const TOKEN = "01900000-0000-7000-8000-00000000c001";

  it("maps the label, the label without its dot, and the given name", () => {
    expect(rosterFromDisplayName("Zephaniah Q.", TOKEN).map((e) => e.name)).toEqual([
      "Zephaniah Q.",
      "Zephaniah Q",
      "Zephaniah",
    ]);
    expect(rosterFromDisplayName("Zephaniah Q.", TOKEN).every((e) => e.token === TOKEN)).toBe(true);
  });

  it("maps a one-word display name once", () => {
    expect(rosterFromDisplayName("Zephaniah", TOKEN).map((e) => e.name)).toEqual(["Zephaniah"]);
  });

  it("maps nothing for a given name too short to substitute safely", () => {
    expect(rosterFromDisplayName("Ed A.", TOKEN)).toEqual([]);
    expect(rosterFromDisplayName("  ", TOKEN)).toEqual([]);
  });

  it("tokenizes with the roster, not instead of it", () => {
    const extra = rosterFromDisplayName("Zephaniah Q.", TOKEN);
    expect(tokenizeNames("Zephaniah and Noah are both out", extra)).toBe(`${TOKEN} and C2 are both out`);
  });

  it("a deployment's own row wins over a fixture of the same name", () => {
    const extra = rosterFromDisplayName("Noah O.", TOKEN);
    expect(tokenizeNames("Noah O. is staying home", extra)).toBe(`${TOKEN} is staying home`);
  });

  it("clears the gateway's name check for a name no fixture carries", () => {
    const extra = rosterFromDisplayName("Zephaniah Q.", TOKEN);
    const raw = "Zephaniah Q. will not need the van";
    expect(tokenizeNames(raw, extra)).toBe(`${TOKEN} will not need the van`);
    expect(findLeaks(tokenizeNames(raw, extra)).some((f) => f.kind === "NAME")).toBe(false);
  });
});
