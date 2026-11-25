const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../lib");

test("addDays crosses month, year and leap-day boundaries", () => {
  assert.equal(lib.addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(lib.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(lib.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(lib.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(lib.addDays("2026-11-21", 30), "2026-12-21");
});

test("isValidDate rejects impossible and badly formatted dates", () => {
  assert.equal(lib.isValidDate("2026-02-28"), true);
  assert.equal(lib.isValidDate("2026-02-30"), false);
  assert.equal(lib.isValidDate("2026-13-01"), false);
  assert.equal(lib.isValidDate("5/12/2026"), false);
  assert.equal(lib.isValidDate(20260101), false);
});

test("toCents converts money exactly and refuses nonsense", () => {
  assert.equal(lib.toCents("50"), 5000);
  assert.equal(lib.toCents("49.99"), 4999);
  assert.equal(lib.toCents("0.5"), 50);
  assert.equal(lib.toCents(12.3), 1230);
  assert.equal(lib.toCents("3000"), 300000);
  assert.equal(lib.toCents("0"), null);
  assert.equal(lib.toCents("-5"), null);
  assert.equal(lib.toCents("1.234"), null);
  assert.equal(lib.toCents("abc"), null);
  assert.equal(lib.toCents(""), null);
  assert.equal(lib.toCents(undefined), null);
});

test("normalizePhone cleans valid numbers and rejects bad ones", () => {
  assert.deepEqual(lib.normalizePhone("+92 300-1234567"), { value: "+923001234567" });
  assert.deepEqual(lib.normalizePhone("(021) 555 1234"), { value: "0215551234" });
  assert.deepEqual(lib.normalizePhone(""), { value: null });
  assert.deepEqual(lib.normalizePhone(undefined), { value: null });
  assert.ok(lib.normalizePhone("abc").error);
  assert.ok(lib.normalizePhone("123").error);
});

test("csvCell quotes special characters and neutralizes formulas", () => {
  assert.equal(lib.csvCell("plain"), "plain");
  assert.equal(lib.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(lib.csvCell("a,b"), '"a,b"');
  assert.equal(lib.csvCell(null), "");
  assert.equal(lib.csvCell("=1+1"), "'=1+1");
  assert.equal(lib.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(lib.csvCell("+923001234567"), "+923001234567"); // a phone number is left alone
  assert.equal(lib.csvCell("-5"), "-5");
});

test("parseJpegDataUrl accepts only JPEG-shaped data of the allowed size", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]);
  const url = "data:image/jpeg;base64," + jpeg.toString("base64");

  assert.ok(lib.parseJpegDataUrl(url, 1000));
  assert.equal(lib.parseJpegDataUrl(url, 3), null); // too big
  assert.equal(lib.parseJpegDataUrl(url.replace("jpeg", "png"), 1000), null);
  assert.equal(lib.parseJpegDataUrl("data:image/jpeg;base64,AAAA", 1000), null); // wrong magic bytes
  assert.equal(lib.parseJpegDataUrl(123, 1000), null);
});

test("toE164 builds international numbers or refuses", () => {
  assert.equal(lib.toE164("0300 1234567", "92"), "+923001234567");
  assert.equal(lib.toE164("+92 300-1234567", "92"), "+923001234567");
  assert.equal(lib.toE164("923001234567", "92"), "+923001234567");
  assert.equal(lib.toE164("0092 300 1234567", "92"), "+923001234567");
  assert.equal(lib.toE164("(021) 555 1234", "92"), "+92215551234");
  assert.equal(lib.toE164("+1 202 555 0100", "92"), "+12025550100");
  assert.equal(lib.toE164("12345678", "92"), null); // which country?
  assert.equal(lib.toE164("0123", "92"), null);      // too short
  assert.equal(lib.toE164("abc", "92"), null);
  assert.equal(lib.toE164(null, "92"), null);
});

test("daysBetween and dueThreshold pick the right reminder window", () => {
  assert.equal(lib.daysBetween("2026-11-21", "2026-11-28"), 7);
  assert.equal(lib.daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(lib.daysBetween("2026-11-21", "2026-11-21"), 0);
  assert.equal(lib.daysBetween("2026-11-21", "2026-11-20"), -1);

  const windows = [7, 1];
  assert.equal(lib.dueThreshold(8, windows), null);
  assert.equal(lib.dueThreshold(7, windows), 7);
  assert.equal(lib.dueThreshold(2, windows), 7);
  assert.equal(lib.dueThreshold(1, windows), 1);
  assert.equal(lib.dueThreshold(0, windows), 1);
  assert.equal(lib.dueThreshold(-1, windows), null);
});

test("renderTemplate fills known placeholders and leaves unknown ones alone", () => {
  const out = lib.renderTemplate("Hi {name}, {when} at {gym} {unknown}", { name: "Ali", when: "tomorrow", gym: "Fit" });
  assert.equal(out, "Hi Ali, tomorrow at Fit {unknown}");
  assert.equal(lib.firstName("Ali Raza Khan"), "Ali");
  assert.equal(lib.whenPhrase(0), "today");
  assert.equal(lib.whenPhrase(1), "tomorrow");
  assert.equal(lib.whenPhrase(5), "in 5 days");
});