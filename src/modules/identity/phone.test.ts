import { describe, expect, it } from "vitest";
import { normalizeE164, phoneHmac, tokenizeBody } from "./phone";

const PEPPER = "test-pepper-0123456789abcdef";

describe("identity phone primitives (DATA-MODEL §1)", () => {
  it("normalizes the shapes a webhook or a URL can carry, and refuses the rest", () => {
    for (const raw of ["+15615550101", "15615550101", "5615550101", "(561) 555-0101", "561-555-0101", " +1 561 555 0101 "]) {
      expect(normalizeE164(raw)).toBe("+15615550101");
    }
    for (const raw of ["", "555", "+44 20 7946 0101", "15615550101234", "1615550101"]) expect(normalizeE164(raw)).toBeNull();
  });

  it("phone_hmac is stable, pepper-dependent and never the number itself", () => {
    const a = phoneHmac("+15615550101", PEPPER);
    expect(a).toBe(phoneHmac("+15615550101", PEPPER));
    expect(a).not.toBe(phoneHmac("+15615550102", PEPPER));
    expect(a).not.toBe(phoneHmac("+15615550101", PEPPER + "x"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("5550101");
  });

  it("refuses a missing or short pepper instead of writing a weak blind index", () => {
    expect(() => phoneHmac("+15615550101", "")).toThrow(/pepper/);
    expect(() => phoneHmac("+15615550101", "short")).toThrow(/pepper/);
  });

  it("tokenizes contact details out of a body but keeps the words staff need", () => {
    expect(tokenizeBody("text my new number 561-555-0107 instead")).toBe("text my new number [phone] instead");
    expect(tokenizeBody("reach me at syn.guardian@example.com")).toBe("reach me at [email]");
    expect(tokenizeBody("Mia is staying home sick today")).toBe("Mia is staying home sick today");
    expect(tokenizeBody("running 10 min late")).toBe("running 10 min late");
  });
});
