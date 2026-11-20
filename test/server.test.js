import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server.js";
const config = {
  teacherKey: "test-only-teacher",
  apiKey: "test-key",
  apiSecret: "test-only-secret-with-at-least-32-characters",
  livekitUrl: "ws://localhost:7880",
};
test("lesson, role restrictions, live cards, private answers and persistence", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "clasp-"));
  let server = createApp({ ...config, dataDir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function call(route, body, token) {
    const res = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  assert.equal(
    (await call("/api/host", { key: "wrong", title: "Test" })).status,
    403,
  );
  const teacher = (
    await call("/api/host", { key: config.teacherKey, title: "ESP lab" })
  ).body;
  const student = (
    await call("/api/join", { code: teacher.code, name: "Anna" })
  ).body;
  const other = (
    await call("/api/join", { code: teacher.code, name: "Dmitry" })
  ).body;
  assert.equal(
    (
      await call(
        "/api/cards",
        { kind: "text", title: "Forbidden", body: "x" },
        student.token,
      )
    ).status,
    403,
  );
  const abort = new AbortController();
  const stream = await fetch(base + "/api/events", {
    headers: { Authorization: `Bearer ${student.token}` },
    signal: abort.signal,
  });
  const reader = stream.body.getReader();
  await reader.read();
  assert.equal(
    (
      await call(
        "/api/cards",
        { kind: "task", title: "Code review", body: "Disagree politely." },
        teacher.token,
      )
    ).status,
    201,
  );
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /Code review/);
  abort.abort();
  const cards = (await call("/api/state", undefined, student.token)).body.cards;
  await call(
    "/api/answers",
    { cardId: cards[0].id, body: "Could we consider another approach?" },
    student.token,
  );
  assert.equal(
    (await call("/api/state", undefined, other.token)).body.answers.length,
    0,
  );
  assert.equal(
    (await call("/api/state", undefined, teacher.token)).body.answers.length,
    1,
  );
  for (const [session, canPublish] of [
    [teacher, true],
    [student, false],
  ]) {
    const media = (await call("/api/media-token", {}, session.token)).body;
    const jwt = JSON.parse(Buffer.from(media.token.split(".")[1], "base64url"));
    assert.equal(jwt.video.canPublish, canPublish);
    assert.equal(jwt.video.canPublishData, false);
    if (canPublish)
      assert.deepEqual(jwt.video.canPublishSources, ["screen_share"]);
    else assert.equal(jwt.video.canSubscribe, true);
  }
  const late = (
    await call("/api/join", { code: teacher.code, name: "Late student" })
  ).body;
  assert.equal(late.cards.length, 1);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  server = createApp({ ...config, dataDir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const resumed = (
    await call("/api/host", {
      key: config.teacherKey,
      lessonId: teacher.lessonId,
    })
  ).body;
  assert.equal(resumed.cards.length, 1);
  assert.equal(resumed.answers.length, 1);
});
