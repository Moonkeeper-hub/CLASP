import { Room, RoomEvent, Track } from "livekit-client";
const $ = (id) => document.getElementById(id);
let auth = sessionStorage.getItem("clasp-token"),
  state,
  room,
  eventsController,
  active = true,
  mediaConnecting = false;
const error = (e) => {
  $("error").textContent = e.message || String(e);
  $("error").hidden = false;
};
async function api(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
function node(tag, content, cls) {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (cls) el.className = cls;
  return el;
}
function renderCards() {
  // Preserve in-progress answers when presence or another response changes.
  const drafts = new Map(
    [...document.querySelectorAll("[data-draft]")].map((el) => [
      el.dataset.draft,
      {
        value: el.value,
        start: el.selectionStart,
        end: el.selectionEnd,
        focused: el === document.activeElement,
      },
    ]),
  );
  $("cards").replaceChildren();
  if (!state.cards.length)
    $("cards").append(node("p", "Здесь появятся материалы и задания.", "hint"));
  for (const c of [...state.cards].reverse()) {
    const el = node("article", undefined, "card");
    el.append(
      node("span", c.kind === "task" ? "Задание" : "Материал", "tag"),
      node("h3", c.title),
      node("div", c.body, "body"),
    );
    const answers = state.answers.filter((a) => a.cardId === c.id);
    if (state.role === "teacher")
      for (const a of answers)
        el.append(node("div", `${a.name}\n${a.body}`, "answer"));
    else if (c.kind === "task") {
      const form = node("form"),
        label = node("label", "Ваш ответ"),
        input = node("textarea"),
        button = node(
          "button",
          answers.length ? "Обновить ответ" : "Отправить ответ",
        );
      input.rows = 4;
      input.maxLength = 12000;
      input.required = true;
      input.dataset.draft = c.id;
      input.value = drafts.get(c.id)?.value ?? answers[0]?.body ?? "";
      label.append(input);
      form.append(label, button);
      if (answers.length) form.append(node("span", "Ответ сохранён", "hint"));
      form.onsubmit = async (e) => {
        e.preventDefault();
        button.disabled = true;
        try {
          await api("/api/answers", { cardId: c.id, body: input.value });
        } catch (e) {
          error(e);
        } finally {
          button.disabled = false;
        }
      };
      el.append(form);
    }
    $("cards").append(el);
  }
  for (const input of document.querySelectorAll("[data-draft]")) {
    const draft = drafts.get(input.dataset.draft);
    if (draft?.focused) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(draft.start, draft.end);
    }
  }
}
function render(next) {
  state = next;
  $("login").hidden = true;
  $("classroom").hidden = false;
  $("lesson-title").textContent = state.title;
  $("role-label").textContent =
    state.role === "teacher" ? "ПРЕПОДАВАТЕЛЬ" : "СТУДЕНТ";
  $("lesson-code").textContent =
    state.role === "teacher"
      ? `Код: ${state.code} · ID: ${state.lessonId}`
      : `Участник: ${state.name}`;
  $("share").hidden = state.role !== "teacher";
  $("card-form").hidden = state.role !== "teacher";
  $("attendance").textContent = state.students
    ? `В аудитории: ${state.students.length} · ${state.students.map((s) => s.name).join(", ")}`
    : "";
  renderCards();
}
async function watch() {
  eventsController?.abort();
  const controller = (eventsController = new AbortController());
  while (active && !controller.signal.aborted) {
    try {
      const res = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${auth}` },
        signal: controller.signal,
      });
      if (!res.ok)
        throw new Error("Не удалось подключить карточки. Войдите заново.");
      $("connection").textContent = "Карточки подключены";
      const reader = res.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith("data: ")) render(JSON.parse(event.slice(6)));
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      $("connection").textContent = "Восстанавливаем связь с карточками…";
    }
    if (!controller.signal.aborted)
      await new Promise((r) => setTimeout(r, 2000));
  }
}
function attach(track) {
  if (track.source !== Track.Source.ScreenShare) return;
  for (const video of $("screen").querySelectorAll("video")) video.remove();
  const video = track.attach();
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  $("screen").append(video);
  $("screen-status").hidden = true;
}
function clearScreen() {
  for (const video of $("screen").querySelectorAll("video")) video.remove();
  $("screen-status").hidden = false;
  $("screen-status").textContent = "Преподаватель пока не демонстрирует экран";
}
function shareLabel() {
  $("share").textContent = room?.localParticipant.isScreenShareEnabled
    ? "Остановить показ"
    : "Показать экран";
}
async function connectMedia() {
  if (mediaConnecting) return;
  mediaConnecting = true;
  $("reconnect").disabled = true;
  $("share").disabled = true;
  try {
    if (!isSecureContext)
      throw new Error(
        "Трансляция требует HTTPS с доверенным сертификатом. См. инструкцию запуска.",
      );
    if (room) await room.disconnect();
    clearScreen();
    room = new Room({
      adaptiveStream: true,
      dynacast: false,
      publishDefaults: {
        simulcast: false,
        videoCodec: "vp8",
        screenShareEncoding: { maxBitrate: 4000000, maxFramerate: 15 },
      },
    });
    room.on(RoomEvent.TrackSubscribed, attach);
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      clearScreen();
    });
    room.on(RoomEvent.LocalTrackPublished, (pub) => {
      if (pub.track) attach(pub.track);
      shareLabel();
    });
    room.on(RoomEvent.LocalTrackUnpublished, () => {
      clearScreen();
      shareLabel();
    });
    room.on(RoomEvent.Reconnecting, () => {
      $("media-status").textContent = "Восстанавливаем трансляцию…";
      $("share").disabled = true;
    });
    room.on(RoomEvent.Reconnected, () => {
      $("media-status").textContent = "Трансляция подключена";
      $("share").disabled = false;
    });
    room.on(RoomEvent.Disconnected, () => {
      $("media-status").textContent = "Трансляция отключена";
      $("share").disabled = true;
      clearScreen();
      shareLabel();
    });
    const credentials = await api("/api/media-token", {});
    await room.connect(credentials.url, credentials.token, {
      autoSubscribe: state.role === "student",
      rtcConfig: { iceServers: [] },
    });
    $("media-status").textContent = "Трансляция подключена";
    $("share").disabled = false;
  } catch (e) {
    $("media-status").textContent = "Не удалось подключить трансляцию";
    error(e);
  } finally {
    mediaConnecting = false;
    $("reconnect").disabled = false;
  }
}
for (const [id, url] of [
  ["student-login", "/api/join"],
  ["teacher-login", "/api/host"],
])
  $(id).onsubmit = async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("button");
    button.disabled = true;
    try {
      $("error").hidden = true;
      const result = await api(url, Object.fromEntries(new FormData(e.target)));
      auth = result.token;
      sessionStorage.setItem("clasp-token", auth);
      e.target.reset();
      render(result);
      watch();
      connectMedia();
    } catch (e) {
      error(e);
    } finally {
      button.disabled = false;
    }
  };
$("card-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/cards", Object.fromEntries(new FormData(e.target)));
    e.target.reset();
  } catch (e) {
    error(e);
  } finally {
    button.disabled = false;
  }
};
$("share").onclick = async () => {
  const button = $("share");
  button.disabled = true;
  try {
    await room.localParticipant.setScreenShareEnabled(
      !room.localParticipant.isScreenShareEnabled,
      {
        audio: false,
        resolution: { width: 1920, height: 1080, frameRate: 15 },
      },
      {
        simulcast: false,
        videoCodec: "vp8",
        screenShareEncoding: { maxBitrate: 4000000, maxFramerate: 15 },
      },
    );
    shareLabel();
  } catch (e) {
    if (e.name !== "NotAllowedError") error(e);
  } finally {
    button.disabled = false;
  }
};
$("reconnect").onclick = connectMedia;
$("fullscreen").onclick = () => {
  $("screen").requestFullscreen().catch(error);
};
$("leave").onclick = async () => {
  active = false;
  eventsController?.abort();
  sessionStorage.removeItem("clasp-token");
  await room?.disconnect();
  location.reload();
};
$("export").onclick = () => {
  const lines = [
    state.title,
    "",
    ...state.cards.flatMap((c) => [
      `${c.kind === "task" ? "Задание" : "Материал"}: ${c.title}`,
      c.body,
      ...state.answers
        .filter((a) => a.cardId === c.id)
        .map((a) => `\nОтвет (${a.name}):\n${a.body}`),
      "",
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }),
  );
  const a = node("a");
  a.href = url;
  a.download = "clasp-notes.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
if (auth)
  api("/api/state")
    .then((s) => {
      render(s);
      watch();
      connectMedia();
    })
    .catch(() => {
      sessionStorage.removeItem("clasp-token");
      auth = null;
    });
