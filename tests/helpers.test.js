const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../lib");
const Barcode = require("../public/barcode.js");

test("memberStatus puts cancelled and frozen before the dates", () => {
  const today = "2026-11-24";
  assert.equal(lib.memberStatus({ end_date: "2026-12-30" }, today), "Active");
  assert.equal(lib.memberStatus({ end_date: "2026-11-28" }, today), "Expiring");
  assert.equal(lib.memberStatus({ end_date: "2026-11-23" }, today), "Expired");
  assert.equal(lib.memberStatus({ end_date: "2027-01-01", frozen_since: "2026-11-20" }, today), "Frozen");
  assert.equal(lib.memberStatus({ end_date: "2026-11-01", frozen_since: "2026-11-20" }, today), "Frozen");
  assert.equal(lib.memberStatus({ end_date: "2027-01-01", cancelled_on: "2026-11-20", frozen_since: "2026-11-01" }, today), "Cancelled");
});

test("parseCsv handles quotes, line endings, a BOM and other separators", () => {
  assert.deepEqual(
    lib.parseCsv('\uFEFFName,Phone\r\n"Khan, Ali","0300 1"\r\n\r\nSara,"say ""hi"""\r\n'),
    [["Name", "Phone"], ["Khan, Ali", "0300 1"], ["Sara", 'say "hi"']]
  );
  assert.deepEqual(lib.parseCsv("Name;Plan\nAli;Basic"), [["Name", "Plan"], ["Ali", "Basic"]]);
  assert.deepEqual(lib.parseCsv("Name\tPlan\nAli\tBasic"), [["Name", "Plan"], ["Ali", "Basic"]]);
  assert.deepEqual(lib.parseCsv(",b\n"), [["", "b"]]);
});

test("parseImportDate accepts two layouts and refuses impossible dates", () => {
  assert.equal(lib.parseImportDate("2026-12-31"), "2026-12-31");
  assert.equal(lib.parseImportDate("31/12/2026"), "2026-12-31");
  assert.equal(lib.parseImportDate("1.2.2027"), "2027-02-01");
  assert.equal(lib.parseImportDate("2026-1-5"), "2026-01-05");
  assert.equal(lib.parseImportDate("31/02/2026"), null);
  assert.equal(lib.parseImportDate("12/31/2026"), null); // month first is not supported
  assert.equal(lib.parseImportDate(""), null);
  assert.equal(lib.parseImportDate(undefined), null);
});

test("mapImportHeader recognises common column names", () => {
  assert.equal(lib.mapImportHeader("Full Name"), "name");
  assert.equal(lib.mapImportHeader("Mobile Number"), "phone");
  assert.equal(lib.mapImportHeader("Package"), "plan");
  assert.equal(lib.mapImportHeader("End Date"), "end");
  assert.equal(lib.mapImportHeader("Expiry"), "end");
  assert.equal(lib.mapImportHeader("Notes"), null);
});

test("receiptNumber is short, stable and readable", () => {
  assert.equal(lib.receiptNumber("3b241101-e2bb-4255-8caf-4136c566a962"), "RC-3B241101");
});

test("plan names allow normal punctuation and refuse the rest", () => {
  for (const ok of ["Basic", "Gold Plus", "3-Month", "Student (Uni)", "Q&A"]) {
    assert.ok(lib.PLAN_NAME_RE.test(ok), ok);
  }
  for (const bad of ["", " Basic", "<b>x</b>", "a".repeat(31), "semi;colon"]) {
    assert.ok(!lib.PLAN_NAME_RE.test(bad), JSON.stringify(bad));
  }
});

test("the barcode table has every Code 128 pattern with the right total width", () => {
  assert.equal(Barcode.PATTERNS.length, 107);
  Barcode.PATTERNS.slice(0, 106).forEach((p, i) => {
    assert.equal(p.split("").reduce((sum, d) => sum + Number(d), 0), 11, "pattern " + i);
  });
  assert.equal(Barcode.PATTERNS[106].split("").reduce((sum, d) => sum + Number(d), 0), 13);
});

test("barcode check digits and symbol sets are right", () => {
  // Numeric codes of even length use the compact set C
  assert.deepEqual(Barcode.encodeValues("123456"), [105, 12, 34, 56, 44, 106]);
  // Anything else uses set B
  assert.deepEqual(Barcode.encodeValues("PJJ123C"), [104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
  assert.deepEqual(Barcode.encodeValues("12345"), [104, 17, 18, 19, 20, 21, 90, 106]);
  assert.throws(() => Barcode.encodeValues(""));
  assert.throws(() => Barcode.encodeValues("é"));
});

test("barcode SVG has one bar per black stripe plus a white background", () => {
  const svg = Barcode.svg("123456");
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('aria-label="Barcode 123456"'));
  assert.equal((svg.match(/<rect/g) || []).length, 20); // 5 symbols x 3 bars + 4 stop bars + background
});