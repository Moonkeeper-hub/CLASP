import http from "node:http";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AccessToken, TrackSource } from "livekit-server-sdk";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const text = (v, max, label) =>
  typeof v === "string" && v.trim() && v.length <= max
    ? v.trim()
    : fail(400, `Проверьте поле «${label}» (до ${max} знаков).`);
const same = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
export function createApp(config) {
  for (const field of ["teacherKey", "apiKey", "apiSecret", "livekitUrl"])
    if (!config[field]) throw new Error(`Missing ${field}`);
  const dataDir = config.dataDir || "./data";
  mkdirSync(dataDir, { recursive: true });
  const db = path.join(dataDir, "lessons.json");
  const lessons = existsSync(db) ? JSON.parse(readFileSync(db, "utf8")) : {};
  const sessions = new Map(),
    streams = new Map();
  const save = () => {
    writeFileSync(db + ".tmp", JSON.stringify(lessons));
    renameSync(db + ".tmp", db);
  };
  const state = (s) => ({
    role: s.role,
    name: s.name,
    lessonId: s.lessonId,
    title: lessons[s.lessonId].title,
    code: s.role === "teacher" ? lessons[s.lessonId].code : undefined,
    cards: lessons[s.lessonId].cards,
    answers: lessons[s.lessonId].answers.filter(
      (a) => s.role === "teacher" || a.identity === s.identity,
    ),
    students:
      s.role === "teacher"
        ? [...streams.keys()]
            .map((t) => sessions.get(t))
            .filter((x) => x?.lessonId === s.lessonId && x.role === "student")
            .map((x) => ({ id: x.identity, name: x.name }))
        : undefined,
  });
  const broadcast = (id) => {
    for (const [token, clients] of streams) {
      const s = sessions.get(token);
      if (s?.lessonId === id)
        for (const res of clients)
          res.write(`data: ${JSON.stringify(state(s))}\n\n`);
    }
  };
  const authenticate = (req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) fail(401, "Войдите в занятие заново.");
    return [s, token];
  };
  const readBody = async (req) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 32768) fail(413, "Слишком большой запрос.");
    }
    try {
      return JSON.parse(raw || "{}");
    } catch {
      fail(400, "Некорректный JSON.");
    }
  };
  const reply = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  const limits = new Map();
  const rateLimit = (req) => {
    const key = req.socket.remoteAddress;
    const now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || bucket.until < now)
      limits.set(key, (bucket = { count: 0, until: now + 60000 }));
    if (++bucket.count > 100)
      fail(429, "Слишком много попыток. Подождите минуту.");
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method === "GET" && url.pathname === "/health")
        return reply(res, 200, { ok: true });
      if (
        req.method === "POST" &&
        ["/api/host", "/api/join"].includes(url.pathname)
      ) {
        rateLimit(req);
        const body = await readBody(req);
        let lessonId, role, name, identity;
        if (url.pathname === "/api/host") {
          if (!same(body.key, config.teacherKey))
            fail(403, "Неверный ключ преподавателя.");
          lessonId = body.lessonId;
          if (lessonId && !lessons[lessonId]) fail(404, "Занятие не найдено.");
          if (!lessonId) {
            lessonId = randomUUID();
            let code;
            do {
              code = randomBytes(4).toString("hex").toUpperCase();
            } while (Object.values(lessons).some((l) => l.code === code));
            lessons[lessonId] = {
              title: text(body.title, 120, "Название"),
              code,
              cards: [],
              answers: [],
            };
            save();
          }
          role = "teacher";
          name = "Преподаватель";
          identity = "teacher";
        } else {
          const match = Object.entries(lessons).find(
            ([, l]) => l.code === String(body.code).trim().toUpperCase(),
          );
          if (!match) fail(404, "Проверьте код занятия.");
          [lessonId] = match;
          role = "student";
          name = text(body.name, 60, "Имя");
          identity = randomUUID();
        }
        const token = randomBytes(32).toString("hex");
        const s = {
          role,
          name,
          lessonId,
          identity,
          expires: Date.now() + 12 * 3600000,
        };
        sessions.set(token, s);
        return reply(res, 200, { token, ...state(s) });
      }
      if (url.pathname.startsWith("/api/")) {
        const [s, token] = authenticate(req);
        const lesson = lessons[s.lessonId];
        if (req.method === "GET" && url.pathname === "/api/state")
          return reply(res, 200, state(s));
        if (req.method === "GET" && url.pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          if (!streams.has(token)) streams.set(token, new Set());
          streams.get(token).add(res);
          broadcast(s.lessonId);
          const timer = setInterval(() => {
            if (s.expires < Date.now()) res.end();
            else res.write(": heartbeat\n\n");
          }, 15000);
          req.on("close", () => {
            clearInterval(timer);
            const set = streams.get(token);
            set?.delete(res);
            if (!set?.size) streams.delete(token);
            broadcast(s.lessonId);
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/media-token") {
          const at = new AccessToken(config.apiKey, config.apiSecret, {
            identity: s.identity,
            name: s.name,
            ttl: "15m",
          });
          at.addGrant({
            roomJoin: true,
            room: s.lessonId,
            canSubscribe: s.role === "student",
            canPublish: s.role === "teacher",
            canPublishData: false,
            ...(s.role === "teacher"
              ? { canPublishSources: [TrackSource.SCREEN_SHARE] }
              : {}),
          });
          return reply(res, 200, {
            token: await at.toJwt(),
            url: config.livekitUrl,
          });
        }
        if (req.method === "POST" && url.pathname === "/api/cards") {
          if (s.role !== "teacher")
            fail(403, "Карточки отправляет преподаватель.");
          const b = await readBody(req);
          if (!["text", "task"].includes(b.kind))
            fail(400, "Неизвестный тип карточки.");
          if (lesson.cards.length >= 300)
            fail(409, "Достигнут лимит 300 карточек занятия.");
          lesson.cards.push({
            id: randomUUID(),
            kind: b.kind,
            title: text(b.title, 120, "Заголовок"),
            body: text(b.body, 12000, "Текст"),
            createdAt: new Date().toISOString(),
          });
          save();
          broadcast(s.lessonId);
          return reply(res, 201, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/answers") {
          if (s.role !== "student") fail(403, "Ответы отправляют студенты.");
          const b = await readBody(req);
          if (!lesson.cards.some((c) => c.id === b.cardId && c.kind === "task"))
            fail(404, "Задание не найдено.");
          const answer = {
            cardId: b.cardId,
            identity: s.identity,
            name: s.name,
            body: text(b.body, 12000, "Ответ"),
            updatedAt: new Date().toISOString(),
          };
          const index = lesson.answers.findIndex(
            (a) => a.cardId === b.cardId && a.identity === s.identity,
          );
          if (index < 0) lesson.answers.push(answer);
          else lesson.answers[index] = answer;
          save();
          broadcast(s.lessonId);
          return reply(res, 200, { ok: true });
        }
        fail(404, "Адрес не найден.");
      }
      if (req.method !== "GET") fail(405, "Метод не поддерживается.");
      const allowed = {
        "/": "index.html",
        "/app.css": "app.css",
        "/bundle.js": "bundle.js",
      };
      const file = allowed[url.pathname];
      if (!file) fail(404, "Адрес не найден.");
      const bytes = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "public", file),
      );
      res.setHeader(
        "Content-Type",
        file.endsWith(".html")
          ? "text/html; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css"
            : "text/javascript",
      );
      res.end(bytes);
    } catch (e) {
      if (!res.headersSent)
        reply(res, e.status || 500, {
          error: e.status ? e.message : "Ошибка сервера.",
        });
      else res.end();
    }
  });
  server.on("close", () => {
    for (const clients of streams.values())
      for (const res of clients) res.end();
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp({
    teacherKey: process.env.TEACHER_KEY,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    livekitUrl: process.env.LIVEKIT_URL,
    dataDir: process.env.DATA_DIR,
  }).listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
    console.log("CLASP listening on port " + (process.env.PORT || 3000)),
  );
}
