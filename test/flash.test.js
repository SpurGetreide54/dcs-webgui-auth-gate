const test = require("node:test");
const assert = require("node:assert/strict");
const flash = require("../src/flash");

function fakeRes() {
  const res = { cookies: {} };
  res.cookie = (name, value) => {
    res.cookies[name] = value;
  };
  res.clearCookie = () => {};
  return res;
}

function storedFlash(res) {
  return JSON.parse(Object.values(res.cookies)[0]);
}

test("setFlash truncates a long error to 500 characters plus an ellipsis, logging the full text", (t) => {
  const errorMock = t.mock.method(console, "error");
  const res = fakeRes();
  const longError = "x".repeat(600);
  flash.setFlash(res, { error: longError });

  const stored = storedFlash(res);
  assert.equal(stored.error.length, 503);
  assert.ok(stored.error.endsWith("..."));
  assert.equal(stored.error.slice(0, 500), longError.slice(0, 500));
  assert.equal(errorMock.mock.calls.length, 1);
  assert.ok(errorMock.mock.calls[0].arguments[0].includes(longError));
});

test("setFlash leaves a short error/notice untouched and logs nothing", (t) => {
  const errorMock = t.mock.method(console, "error");
  const res = fakeRes();
  flash.setFlash(res, { error: "short error", notice: "short notice" });

  const stored = storedFlash(res);
  assert.equal(stored.error, "short error");
  assert.equal(stored.notice, "short notice");
  assert.equal(errorMock.mock.calls.length, 0);
});

test("setFlash truncates error and notice independently", (t) => {
  const res = fakeRes();
  const longNotice = "y".repeat(600);
  flash.setFlash(res, { error: "short", notice: longNotice });

  const stored = storedFlash(res);
  assert.equal(stored.error, "short");
  assert.equal(stored.notice.length, 503);
  assert.ok(stored.notice.endsWith("..."));
});
